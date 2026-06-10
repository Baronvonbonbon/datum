// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./DatumUpgradable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumRelayStake.sol";

/// @title DatumRelay
/// @notice Publisher relay for claim settlement via EIP-712 user signatures.
///         H-4: Optional authorized relayer list with liveness fallback.
///         H-6: Settlement and campaigns references are now mutable (Ownable2Step).
///         L-1: Inherits OZ EIP712 so the domain separator rebuilds on chainid
///              mismatch (chain-fork safe).
contract DatumRelay is DatumUpgradable, EIP712 {
    function version() public pure override returns (uint256) { return 1; }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,uint256 lastNonce,uint256 claimCount,uint256 deadlineBlock)"
    );

    // A1-fix (2026-05-12): bind claimsHash + deadlineBlock so a captured publisher
    // cosig cannot be replayed with altered claim contents (rates, eventCounts,
    // swapped open-campaign publisher field) or past its expiry. Mirrors the
    // dual-sig path's CLAIM_BATCH_TYPEHASH in DatumSettlement.
    // SLIM-AUDIT-1 (2026-06-10): bind firstNonce too. Slim claims are pure
    // content (publisher, eventCount, rateWei, actionType) — two consecutive
    // batches can be byte-identical, so without the nonce anchor one publisher
    // cosig could be replayed for a second identical-content batch at the next
    // nonce window (the user holds the cosig and signs the fresh user envelope
    // themselves). Matches DatumAttestationVerifier's anchored typehash.
    bytes32 private constant PUBLISHER_ATTESTATION_TYPEHASH = keccak256(
        "PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,bytes32 claimsHash,uint256 deadlineBlock)"
    );

    // -------------------------------------------------------------------------
    // State (H-6: mutable references instead of immutable)
    // -------------------------------------------------------------------------

    IDatumSettlement public settlement;
    IDatumCampaignsSettlement public campaigns;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public immutable pauseRegistry;

    // -------------------------------------------------------------------------
    // H-4: Authorized relayers
    // -------------------------------------------------------------------------

    mapping(address => bool) public authorizedRelayers;
    uint256 public authorizedRelayerCount;
    /// @notice If relay is down for > livenessThresholdBlocks, anyone can submit (liveness guarantee).
    ///         0 = permissionless (no relayer restriction).
    uint256 public livenessThresholdBlocks;
    /// @notice Last block at which an authorized relayer submitted a batch.
    uint256 public lastRelayBlock;

    // ── Relay batch size (governable, was hard-coded 10 in alpha-3) ───────────
    // PVM-legacy cap on per-tx forwarded batches. EVM allows much more.
    uint256 public constant MAX_RELAY_BATCH_CEILING = 200;
    uint256 public maxBatchSize = 50;
    event MaxBatchSizeSet(uint256 value);

    event RelayerAuthorized(address indexed relayer, bool authorized);
    event SettlementUpdated(address indexed newSettlement);
    event CampaignsUpdated(address indexed newCampaigns);
    event RelayerOpenLocked();

    /// @notice B7-fix (2026-05-12): one-way switch. After flip, owner can no
    ///         longer authorize relayers or change the liveness threshold —
    ///         the permissionless-relay path is locked open forever.
    ///         A credible commitment for the cypherpunk roadmap.
    bool public relayerOpenLocked;

    /// @notice D1a cypherpunk plumbing lock. Relay is a forwarding plumbing
    ///         contract; both protocol-ref setters live under this one switch.
    ///         Pre-lock: owner can swap to fix wiring. Post-lock: frozen forever.
    bool public plumbingLocked;
    event PlumbingLocked();

    /// @notice G-1 close: optional stake gate. When wired, a relay passes
    ///         authorization if EITHER manually authorized via
    ///         `authorizedRelayers` OR adequately staked per
    ///         `relayStake.isAuthorized` (pattern (b) augment from the
    ///         relay-accountability proposal). `address(0)` disables the
    ///         stake-gate path — authorization falls back to the
    ///         pre-existing flow.
    IDatumRelayStake public relayStake;
    event RelayStakeSet(address indexed relayStake);
    /// @notice A batch was skipped (not settled, not reverted) because it was
    ///         stale. reason: 0 = expired deadline, 1 = firstNonce anchor
    ///         mismatch (already settled / replayed). claimCount is folded into
    ///         the call's rejectedCount.
    event BatchSkippedStale(address indexed user, uint256 indexed campaignId, uint256 firstNonce, uint256 claimCount, uint8 reason);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _settlement, address _campaigns, address _pauseRegistry)
        EIP712("DatumRelay", "1")
    {
        require(_settlement != address(0), "E00");
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        settlement = IDatumSettlement(_settlement);
        campaigns = IDatumCampaignsSettlement(_campaigns);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        // B1-fix (2026-05-12): default liveness fallback to ~24h (14400 blocks @
        // 6s). The moment the owner authorizes any relayer, the permissionless
        // escape hatch is already on — operators must explicitly call
        // `setLivenessThreshold(0)` to disable, not implicitly via inaction.
        livenessThresholdBlocks = 14400;
    }

    /// @notice Returns the current EIP-712 domain separator. Rebuilds automatically
    ///         on chainid mismatch via OZ EIP712 (L-1).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // -------------------------------------------------------------------------
    // Admin (H-6)
    // -------------------------------------------------------------------------

    /// @dev D1a plumbing-lock pattern: both setters gated by `plumbingLocked`.
    function setSettlement(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        settlement = IDatumSettlement(addr);
        emit SettlementUpdated(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        campaigns = IDatumCampaignsSettlement(addr);
        emit CampaignsUpdated(addr);
    }

    /// @notice D1a: commit both Relay refs permanently.
    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        require(!plumbingLocked, "already locked");
        require(address(settlement) != address(0), "settlement unset");
        require(address(campaigns) != address(0), "campaigns unset");
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    /// @notice Add or remove an authorized relayer (H-4).
    function setRelayerAuthorized(address relayer, bool authorized) external onlyOwner {
        require(!relayerOpenLocked, "open-locked");
        require(relayer != address(0), "E00");
        if (authorized && !authorizedRelayers[relayer]) {
            authorizedRelayers[relayer] = true;
            authorizedRelayerCount++;
        } else if (!authorized && authorizedRelayers[relayer]) {
            authorizedRelayers[relayer] = false;
            authorizedRelayerCount--;
        }
        emit RelayerAuthorized(relayer, authorized);
    }

    /// @notice Set the liveness fallback threshold. If no authorized relayer submits
    ///         within this many blocks, anyone can submit. 0 = always permissionless.
    function setMaxBatchSize(uint256 v) external onlyOwner {
        require(v > 0 && v <= MAX_RELAY_BATCH_CEILING, "E11");
        maxBatchSize = v;
        emit MaxBatchSizeSet(v);
    }

    function setLivenessThreshold(uint256 blocks) external onlyOwner {
        require(!relayerOpenLocked, "open-locked");
        livenessThresholdBlocks = blocks;
    }

    /// @notice B7-fix: permanently commit to the permissionless relay path.
    ///         After this call, owner can no longer authorize relayers or shift
    ///         the liveness threshold. Irreversible.
    function lockRelayerOpen() external onlyOwner whenOpenGovPhase {
        require(!relayerOpenLocked, "already locked");
        // Clearing the authorized set + threshold = anyone-can-relay forever.
        // (Per the gate in settleClaimsFor: authorizedRelayerCount == 0 means
        // no auth check.) Threshold becomes irrelevant once count is zero.
        relayerOpenLocked = true;
        emit RelayerOpenLocked();
    }

    /// @notice G-1 close: wire DatumRelayStake. Pattern (b) augment — a
    ///         relay passes authorization if EITHER manually authorized
    ///         OR adequately staked. `address(0)` disables the stake gate
    ///         entirely (no behavior change from pre-relay-accountability).
    /// @dev    Owner-only; locked under `plumbingLocked` once the relay
    ///         tier reaches its production wiring. Pre-lock, governance
    ///         can rotate to a new RelayStake contract.
    function setRelayStake(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        relayStake = IDatumRelayStake(addr);
        emit RelayStakeSet(addr);
    }

    /// @notice G-1 view: a relay is authorized if it appears in the manual
    ///         allowlist OR if the staking gate is wired and accepts.
    ///         Pure view; called by tests + off-chain monitors.
    function isAuthorizedRelayer(address relayer) public view returns (bool) {
        if (authorizedRelayers[relayer]) return true;
        if (address(relayStake) != address(0) && relayStake.isAuthorized(relayer)) return true;
        return false;
    }

    // -------------------------------------------------------------------------
    // Relay settlement
    // -------------------------------------------------------------------------

    function settleClaimsFor(IDatumSettlement.SignedClaimBatch[] calldata batches)
        external
        whenNotFrozen
        returns (IDatumSettlement.SettlementResult memory result)
    {
        require(!pauseRegistry.pausedSettlement(), "P");

        // H-4 + G-1: relayer authorization check. Pattern (b) augment —
        // staked relays pass alongside manually-authorized ones. The
        // liveness fallback (anyone-may-submit if no authorized relayer
        // has submitted within livenessThresholdBlocks) covers the case
        // where no relay (manual OR staked) has been active recently.
        bool stakeGateOn = address(relayStake) != address(0);
        bool gateActive = authorizedRelayerCount > 0 || stakeGateOn;
        if (gateActive) {
            bool passes = authorizedRelayers[msg.sender]
                || (stakeGateOn && relayStake.isAuthorized(msg.sender));
            if (passes) {
                lastRelayBlock = block.number;
            } else {
                // Liveness fallback
                require(
                    livenessThresholdBlocks > 0 &&
                    block.number > lastRelayBlock + livenessThresholdBlocks,
                    "E18"
                );
            }
        }

        require(batches.length <= maxBatchSize, "E28");
        IDatumSettlement.ClaimBatch[] memory forwardBatches = new IDatumSettlement.ClaimBatch[](batches.length);
        // Graceful-skip accounting: stale/expired batches are skipped (not
        // reverted) so one bad entry can't DoS a multi-user submission. Valid
        // batches are compacted into forwardBatches[0..validCount); skipped
        // claims are folded into result.rejectedCount after the single settle.
        uint256 validCount = 0;
        uint256 skippedRejected = 0;

        for (uint256 b = 0; b < batches.length; b++) {
            IDatumSettlement.SignedClaimBatch calldata sb = batches[b];
            require(sb.claims.length > 0, "E28");

            // Graceful skip (timing): an expired batch is no longer valid but
            // must not revert the whole call. Skip before sig verification.
            if (block.number > sb.deadlineBlock) {
                skippedRejected += sb.claims.length;
                emit BatchSkippedStale(sb.user, sb.campaignId, sb.firstNonce, sb.claims.length, 0);
                continue;
            }

            // EIP-712 user signature verification.
            // L-1: digest built via OZ EIP712 base (`_hashTypedDataV4`) so the
            // domain separator rebuilds on chainid mismatch (chain-fork safe).
            // Recovery uses manual ecrecover to preserve E30/E31 error codes
            // that off-chain clients depend on.
            // SLIM (#2): firstNonce/lastNonce are explicit envelope fields now
            // (the per-claim nonce was dropped). lastNonce is derived from
            // firstNonce + count - 1; the user signs the range.
            bytes32 structHash = keccak256(abi.encode(
                BATCH_TYPEHASH,
                sb.user,
                sb.campaignId,
                sb.firstNonce,
                sb.firstNonce + sb.claims.length - 1,
                sb.claims.length,
                sb.deadlineBlock
            ));
            bytes32 digest = _hashTypedDataV4(structHash);

            bytes calldata sig = sb.userSig;
            require(sig.length == 65, "E30");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            require(v == 27 || v == 28, "E30"); // AUDIT-006: validate v before ecrecover
            require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
            address signer = ecrecover(digest, v, r, s);
            require(signer != address(0) && signer == sb.user, "E31");

            // A3: Enforce publisher cosig at AssuranceLevel >= 1.
            // Campaigns interface for relay lookups already includes the view.
            try campaigns.getCampaignAssuranceLevel(sb.campaignId) returns (uint8 lvl) {
                if (lvl >= 1) {
                    require(sb.publisherSig.length > 0, "E33");
                }
            } catch {}

            // Publisher co-signature (3-value return)
            if (sb.publisherSig.length > 0) {
                (, address cPublisher,) = campaigns.getCampaignForSettlement(sb.campaignId);
                address expectedPub = cPublisher;
                if (expectedPub == address(0)) {
                    expectedPub = sb.claims[0].publisher;
                    // SM-1: Verify all claims target the same publisher for open campaigns
                    for (uint256 i = 1; i < sb.claims.length; i++) {
                        require(sb.claims[i].publisher == expectedPub, "E34");
                    }
                }
                if (expectedPub != address(0)) {
                    // A1-fix: hash all claims into a single claimsHash.
                    // SLIM (#2): claimHash was dropped from the wire, so bind to
                    // a content hash of each slim claim — keccak(abi.encode(claim)).
                    // Matches DatumDualSigSettlement._hashClaims for symmetry.
                    bytes32[] memory _hashes = new bytes32[](sb.claims.length);
                    for (uint256 i = 0; i < sb.claims.length; i++) {
                        _hashes[i] = keccak256(abi.encode(sb.claims[i]));
                    }
                    bytes32 claimsHash = keccak256(abi.encodePacked(_hashes));
                    bytes32 pubStructHash = keccak256(abi.encode(
                        PUBLISHER_ATTESTATION_TYPEHASH,
                        sb.campaignId,
                        sb.user,
                        sb.firstNonce, // SLIM-AUDIT-1: replay anchor
                        claimsHash,
                        sb.deadlineBlock
                    ));
                    bytes32 pubDigest = _hashTypedDataV4(pubStructHash);

                    bytes calldata pubSig = sb.publisherSig;
                    require(pubSig.length == 65, "E33");
                    bytes32 pr;
                    bytes32 ps;
                    uint8 pv;
                    assembly {
                        pr := calldataload(pubSig.offset)
                        ps := calldataload(add(pubSig.offset, 32))
                        pv := byte(0, calldataload(add(pubSig.offset, 64)))
                    }
                    require(pv == 27 || pv == 28, "E30"); // AUDIT-006: validate v before ecrecover
                    require(uint256(ps) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
                    address pubSigner = ecrecover(pubDigest, pv, pr, ps);
                    require(pubSigner != address(0) && pubSigner == expectedPub, "E34");
                }
            }

            // Graceful skip (staleness): replay anchor. Checked AFTER sig
            // verification so a malformed sig still reverts, but a valid sig
            // over a stale firstNonce (already settled / replayed) is skipped.
            // settleClaims (forwarded below) derives nonces from the same chain
            // head, and lastNonce advances past firstNonce after settlement.
            if (sb.firstNonce != settlement.lastNonce(sb.user, sb.campaignId, sb.claims[0].actionType) + 1) {
                skippedRejected += sb.claims.length;
                emit BatchSkippedStale(sb.user, sb.campaignId, sb.firstNonce, sb.claims.length, 1);
                continue;
            }

            // One-chain-per-call guard (E87). Two batches that would BOTH settle
            // for the same (user, campaignId, actionType) chain in one call would
            // double-settle: this is a deferred-settle path (a single settleClaims
            // at the end), so the anchor above reads the same pre-settlement
            // lastNonce for both, and settleClaims then assigns them sequential
            // nonces — re-playing one signed authorization. Reject the whole call.
            // Checked only against already-accepted batches, so an expired/stale
            // sibling for the same chain (already skipped) does not false-trigger.
            uint8 at = sb.claims[0].actionType;
            for (uint256 j = 0; j < validCount; j++) {
                require(
                    forwardBatches[j].user != sb.user ||
                    forwardBatches[j].campaignId != sb.campaignId ||
                    forwardBatches[j].claims[0].actionType != at,
                    "E87"
                );
            }

            // Build ClaimBatch for forwarding (compacted at validCount)
            IDatumSettlement.Claim[] memory memoryClaims = new IDatumSettlement.Claim[](sb.claims.length);
            for (uint256 i = 0; i < sb.claims.length; i++) {
                memoryClaims[i] = sb.claims[i];
            }
            forwardBatches[validCount] = IDatumSettlement.ClaimBatch({
                user: sb.user,
                campaignId: sb.campaignId,
                claims: memoryClaims
            });
            validCount++;
        }

        // Forward only the valid (compacted) batches; fold skipped claims into
        // the rejected count so callers see them without a struct change.
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
