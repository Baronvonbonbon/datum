// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./DatumUpgradable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumAttestationVerifier
/// @notice P1: Mandatory publisher attestation for direct claim settlement.
///         Wraps settleClaims() and enforces EIP-712 publisher co-signature
///         for ALL campaigns. Targeted campaigns verify against the campaign's
///         designated publisher. Open campaigns (publisher=address(0)) verify
///         against claims[0].publisher (the actual serving publisher).
///
///         Users call settleClaimsAttested() instead of Settlement.settleClaims()
///         directly. This contract verifies publisher attestation then forwards
///         to Settlement. Relay also enforces attestation when a co-sig is
///         provided; this contract makes it mandatory.
///
///         R-M3: Inherits OZ EIP712 so the domain separator rebuilds on chainid
///               mismatch (chain-fork safe).
contract DatumAttestationVerifier is EIP712, DatumUpgradable {
    /// @notice F-033 fix (2026-05-20): on the upgrade ladder so a future
    ///         bug in the on-chain ECDSA / EIP-712 verification surface
    ///         can be hot-fixed via the standard
    ///         `DatumGovernanceRouter.upgradeContract` path instead of
    ///         requiring a full Settlement redeploy + state migration.
    function version() public pure override returns (uint256) { return 1; }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    // A1-fix (2026-05-12): bind claimsHash + deadlineBlock so a captured publisher
    // cosig cannot be replayed with altered claim contents (rates, eventCounts,
    // swapped open-campaign publisher field) or past its expiry. Mirrors the
    // dual-sig path's CLAIM_BATCH_TYPEHASH in DatumSettlement.
    // SLIM (#2): firstNonce added so the publisher cosig is anchored to a
    // chain position. With per-claim nonces dropped from the wire, the cosig
    // (bound only to content + deadline) would otherwise be replayable — the
    // user is the tx sender here, so there is no user sig to block it.
    bytes32 private constant PUBLISHER_ATTESTATION_TYPEHASH = keccak256(
        "PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,bytes32 claimsHash,uint256 deadlineBlock)"
    );

    /// @notice An attested batch was skipped (not settled, not reverted)
    ///         because it was stale. reason: 0 = expired deadline, 1 =
    ///         firstNonce anchor mismatch. claimCount is folded into rejectedCount.
    event BatchSkippedStale(address indexed user, uint256 indexed campaignId, uint256 firstNonce, uint256 claimCount, uint8 reason);

    // -------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------

    IDatumSettlement public immutable settlement;
    IDatumCampaignsSettlement public immutable campaigns;
    IDatumPauseRegistry public immutable pauseRegistry;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _settlement, address _campaigns, address _pauseRegistry)
        EIP712("DatumAttestationVerifier", "1")
    {
        require(_settlement != address(0), "E00");
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        settlement = IDatumSettlement(_settlement);
        campaigns = IDatumCampaignsSettlement(_campaigns);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    /// @notice Returns the current EIP-712 domain separator. Rebuilds automatically
    ///         on chainid mismatch via OZ EIP712 (R-M3).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // -------------------------------------------------------------------------
    // Attested settlement
    // -------------------------------------------------------------------------

    struct AttestedBatch {
        address user;
        uint256 campaignId;
        uint256 firstNonce;    // SLIM (#2): nonce of claims[0]; anchored to lastNonce+1
        IDatumSettlement.Claim[] claims;
        uint256 deadlineBlock; // A1-fix: bound to publisher sig
        bytes publisherSig;
    }

    /// @notice Settle claims with mandatory publisher attestation.
    ///         publisherSig must be a valid EIP-712 signature from the publisher.
    ///         Targeted campaigns: verified against campaign's designated publisher.
    ///         Open campaigns: verified against claims[0].publisher (the serving publisher).
    function settleClaimsAttested(AttestedBatch[] calldata batches)
        external
        whenNotFrozen
        returns (IDatumSettlement.SettlementResult memory result)
    {
        // S4: Pause check (mirrors Settlement.settleClaims)
        require(!pauseRegistry.pausedSettlement(), "P");

        IDatumSettlement.ClaimBatch[] memory forwardBatches =
            new IDatumSettlement.ClaimBatch[](batches.length);
        // Graceful-skip accounting: stale/expired batches are skipped (not
        // reverted) so one bad entry can't DoS a multi-batch submission.
        uint256 validCount = 0;
        uint256 skippedRejected = 0;

        for (uint256 b = 0; b < batches.length; b++) {
            AttestedBatch calldata ab = batches[b];
            require(msg.sender == ab.user, "E32");
            require(ab.claims.length > 0, "E28");

            // Graceful skip (timing): expired batch is stale, not malformed.
            if (block.number > ab.deadlineBlock) {
                skippedRejected += ab.claims.length;
                emit BatchSkippedStale(ab.user, ab.campaignId, ab.firstNonce, ab.claims.length, 0);
                continue;
            }

            // Determine expected publisher signer
            (, address cPublisher,) = campaigns.getCampaignForSettlement(ab.campaignId);
            address expectedPublisher = cPublisher;
            if (expectedPublisher == address(0)) {
                // Open campaign: verify against the actual serving publisher.
                // NOTE: claims[0].publisher is self-reported here. Defense-in-depth is
                // provided by DatumClaimValidator downstream, which checks publisher
                // registration in DatumPublishers before accepting settlement.
                expectedPublisher = ab.claims[0].publisher;
            }
            require(expectedPublisher != address(0), "E00");
            // F-034 fix (2026-05-20): every claim in the batch must target
            // the SAME publisher as claims[0], for ALL paths (open and
            // targeted). Without this on the targeted-multi-publisher
            // path, the signing publisher's cosig would implicitly attest
            // to claims attributed to other allowlisted publishers,
            // letting an attacker exploit the multi-publisher payment
            // misallocation in LogicB (F-001) via this entry point.
            // LogicB's own check (F-001 fix) catches the same case
            // downstream; this is defense-in-depth at the attestation
            // boundary.
            address p0 = ab.claims[0].publisher;
            for (uint256 i = 1; i < ab.claims.length; i++) {
                require(ab.claims[i].publisher == p0, "E34");
            }

            // (deadline checked up front as a graceful skip.)

            // Mandatory: verify publisher co-signature.
            // SLIM (#2): claimHash dropped from the wire — bind to a content
            //         hash of each slim claim, keccak(abi.encode(claim)).
            //         Matches DatumDualSigSettlement._hashClaims for symmetry.
            // R-M3: digest built via OZ _hashTypedDataV4 so the domain separator
            //       rebuilds on chainid mismatch (chain-fork safe).
            bytes32 claimsHash;
            {
                bytes32[] memory _hashes = new bytes32[](ab.claims.length);
                for (uint256 i = 0; i < ab.claims.length; i++) {
                    _hashes[i] = keccak256(abi.encode(ab.claims[i]));
                }
                claimsHash = keccak256(abi.encodePacked(_hashes));
            }
            bytes32 structHash = keccak256(abi.encode(
                PUBLISHER_ATTESTATION_TYPEHASH,
                ab.campaignId,
                ab.user,
                ab.firstNonce,
                claimsHash,
                ab.deadlineBlock
            ));
            bytes32 digest = _hashTypedDataV4(structHash);

            bytes calldata sig = ab.publisherSig;
            require(sig.length == 65, "E33");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            require(v == 27 || v == 28, "E30");
            require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
            address pubSigner = ecrecover(digest, v, r, s);
            address relaySig = campaigns.getCampaignRelaySigner(ab.campaignId);
            address expectedSigner = (relaySig != address(0)) ? relaySig : expectedPublisher;
            require(pubSigner != address(0) && pubSigner == expectedSigner, "E34");

            // Graceful skip (staleness): replay anchor, checked AFTER the cosig
            // so a malformed cosig still reverts but a valid cosig over a stale
            // firstNonce is skipped, not reverted.
            if (ab.firstNonce != settlement.lastNonce(ab.user, ab.campaignId, ab.claims[0].actionType) + 1) {
                skippedRejected += ab.claims.length;
                emit BatchSkippedStale(ab.user, ab.campaignId, ab.firstNonce, ab.claims.length, 1);
                continue;
            }

            // Build ClaimBatch for forwarding (compacted at validCount)
            IDatumSettlement.Claim[] memory memoryClaims =
                new IDatumSettlement.Claim[](ab.claims.length);
            for (uint256 i = 0; i < ab.claims.length; i++) {
                memoryClaims[i] = ab.claims[i];
            }
            forwardBatches[validCount] = IDatumSettlement.ClaimBatch({
                user: ab.user,
                campaignId: ab.campaignId,
                claims: memoryClaims
            });
            validCount++;
        }

        if (validCount > 0) {
            IDatumSettlement.ClaimBatch[] memory toForward = forwardBatches;
            if (validCount < batches.length) {
                toForward = new IDatumSettlement.ClaimBatch[](validCount);
                for (uint256 i = 0; i < validCount; i++) toForward[i] = forwardBatches[i];
            }
            result = settlement.settleClaims(toForward);
        }
        result.rejectedCount += skippedRejected;
    }
}
