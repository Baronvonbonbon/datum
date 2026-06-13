// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./DatumUpgradable.sol";
import "./interfaces/IDatumDualSigSettlement.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title  DatumDualSigSettlement
/// @notice Carve-out of DatumSettlement's `settleSignedClaims` path. Verifies
///         publisher + advertiser EIP-712 signatures over a `ClaimBatch`
///         envelope, then forwards each verified batch to Settlement via
///         `processVerifiedBatch` (gated to this contract).
///
/// @dev    Domain `"DatumSettlement" v"1"` preserved so off-chain signers
///         keep producing the same digests they did before the carve-out.
///         The historic `CLAIM_BATCH_TYPEHASH` is unchanged.
///
///         Auth model (mirrors the previous inline path):
///           - Publisher sig must come from `expectedRelaySigner` if set
///             AND that key must still be the publisher's currently-wired
///             relay signer (anti-rotation). Otherwise strict: publisher's
///             EOA.
///           - Advertiser sig: same pattern, against
///             `expectedAdvertiserRelaySigner` and the advertiser's
///             currently-wired delegated key.
///           - Every claim in the batch must target the same publisher as
///             claims[0] (M-3 / SM-1).
///
///         Hot-path impact: only the dual-sig submission path goes through
///         here. Permissionless relay (`settleClaims`) and multi-user
///         (`settleClaimsMulti`) submissions remain on Settlement, no
///         change to their gas profile.
contract DatumDualSigSettlement is
    IDatumDualSigSettlement,
    DatumUpgradable,
    ReentrancyGuard,
    EIP712
{
    // v2: adds the A1 independence guard (E89) — publisher-side and
    // advertiser-side signatures must recover to distinct keys.
    function version() public pure override returns (uint256) { return 2; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    IDatumSettlement public settlement;
    IDatumPauseRegistry public pauseRegistry;
    IDatumPublishers public publishers;
    IDatumCampaigns public campaigns;
    bool public plumbingLocked;

    /// @notice Mirrors the historic Settlement value so off-chain signers
    ///         keep producing valid digests after the carve-out.
    bytes32 public constant CLAIM_BATCH_TYPEHASH = keccak256(
        "ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,bytes32 claimsHash,uint256 deadlineBlock,address expectedRelaySigner,address expectedAdvertiserRelaySigner)"
    );

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event SettlementSet(address indexed settlement);
    event PauseRegistrySet(address indexed registry);
    event PublishersSet(address indexed publishers);
    event CampaignsSet(address indexed campaigns);
    event PlumbingLocked();
    /// @notice A dual-signed batch was skipped (not settled, not reverted)
    ///         because it was stale. reason: 0 = expired deadline, 1 =
    ///         firstNonce anchor mismatch. claimCount is folded into rejectedCount.
    event BatchSkippedStale(address indexed user, uint256 indexed campaignId, uint256 firstNonce, uint256 claimCount, uint8 reason);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E28();
    error E34();
    error E81();
    error E82();
    error E83();
    error E84();
    error E85();
    /// @notice A1 independence guard: the publisher-side and advertiser-side
    ///         signatures recovered to the SAME key. A single party holding
    ///         both keys defeats the dual-sig refutation guarantee ("either
    ///         party can withhold their sig"). Advertiser and publisher are
    ///         always distinct roles in DATUM, so a shared signer is invalid.
    error E89();
    error Paused();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────

    /// @dev EIP-712 domain pinned to ("DatumSettlement", "1") so existing
    ///      off-chain signers keep producing valid digests.
    constructor() EIP712("DatumSettlement", "1") {}

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = IDatumSettlement(addr);
        emit SettlementSet(addr);
    }

    function setPauseRegistry(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        pauseRegistry = IDatumPauseRegistry(addr);
        emit PauseRegistrySet(addr);
    }

    function setPublishers(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        publishers = IDatumPublishers(addr);
        emit PublishersSet(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        campaigns = IDatumCampaigns(addr);
        emit CampaignsSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (address(settlement) == address(0)) revert E00();
        if (address(pauseRegistry) == address(0)) revert E00();
        if (address(campaigns) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Domain separator passthrough (handy for off-chain verification)
    // ─────────────────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumDualSigSettlement
    function settleSignedClaims(IDatumSettlement.SignedClaimBatch[] calldata batches)
        external
        nonReentrant
        whenNotFrozen
        returns (IDatumSettlement.SettlementResult memory result)
    {
        if (address(settlement) == address(0)) revert E00();
        if (address(pauseRegistry) != address(0) && pauseRegistry.pausedSettlement()) revert Paused();

        // Mirror Settlement's outer-array cap: same `maxBatchSize` knob as
        // settleClaims / settleClaimsMulti enforce, read once per call.
        uint256 cap = settlement.maxBatchSize();
        if (batches.length > cap) revert E28();

        for (uint256 b = 0; b < batches.length; b++) {
            IDatumSettlement.SignedClaimBatch calldata batch = batches[b];

            // I-3: reject empty batches -- sigs over no claims do nothing and just burn gas.
            if (batch.claims.length == 0) revert E28();

            // Graceful skip (timing): an expired batch is stale, not malformed —
            // skip it (count its claims as rejected) so it can't DoS the rest of
            // a multi-batch submission. Checked before sig recovery.
            if (block.number > batch.deadlineBlock) {
                result.rejectedCount += batch.claims.length;
                emit BatchSkippedStale(batch.user, batch.campaignId, batch.firstNonce, batch.claims.length, 0);
                continue;
            }

            // Build the EIP-712 struct hash over the batch envelope.
            bytes32 claimsHash = _hashClaims(batch.claims);
            bytes32 structHash = keccak256(abi.encode(
                CLAIM_BATCH_TYPEHASH,
                batch.user,
                batch.campaignId,
                batch.firstNonce,
                claimsHash,
                batch.deadlineBlock,
                batch.expectedRelaySigner,
                batch.expectedAdvertiserRelaySigner
            ));
            bytes32 digest = _hashTypedDataV4(structHash);

            // ── Publisher signature ─────────────────────────────────────────
            address pubSigner = ECDSA.recover(digest, batch.publisherSig);
            address expectedPublisher = _batchPublisher(batch.claims);
            if (expectedPublisher == address(0)) revert E00();
            // M-3 / SM-1: every claim must target the same publisher as claims[0]
            // so the dual-sig path's authorization model matches DatumRelay.
            for (uint256 i = 1; i < batch.claims.length; i++) {
                if (batch.claims[i].publisher != expectedPublisher) revert E34();
            }
            if (batch.expectedRelaySigner != address(0)) {
                if (address(publishers) != address(0)) {
                    address currentRelay = address(0);
                    try publishers.relaySigner(expectedPublisher) returns (address r) {
                        currentRelay = r;
                    } catch {}
                    if (currentRelay != batch.expectedRelaySigner) revert E84();
                }
                if (pubSigner != batch.expectedRelaySigner) revert E82();
            } else {
                if (pubSigner != expectedPublisher) revert E82();
            }

            // ── Advertiser signature ────────────────────────────────────────
            address advSigner = ECDSA.recover(digest, batch.advertiserSig);
            address expectedAdvertiser = campaigns.getCampaignAdvertiser(batch.campaignId);
            if (expectedAdvertiser == address(0)) revert E00();
            if (batch.expectedAdvertiserRelaySigner != address(0)) {
                address currentAdvRelay = address(0);
                try campaigns.getAdvertiserRelaySigner(expectedAdvertiser) returns (address r) {
                    currentAdvRelay = r;
                } catch {}
                if (currentAdvRelay != batch.expectedAdvertiserRelaySigner) revert E85();
                if (advSigner != batch.expectedAdvertiserRelaySigner) revert E83();
            } else {
                if (advSigner != expectedAdvertiser) revert E83();
            }

            // ── A1 independence guard ───────────────────────────────────────
            // The two signatures must come from DISTINCT keys. If the same key
            // satisfied both the publisher-side and advertiser-side checks (e.g.
            // one operator registered as both the publisher's relay signer and
            // the advertiser's delegated signer, or one party holding both EOAs),
            // dual-sig refutation is theater — there is no second party who can
            // independently refuse. Advertiser and publisher are always distinct
            // roles in DATUM, so a shared signer is never legitimate. This is
            // defense-in-depth: it cannot prove off-chain custody independence,
            // but it makes the degenerate same-key collapse unrepresentable.
            if (advSigner == pubSigner) revert E89();

            // Graceful skip (staleness): replay anchor. Pre-checked here (after
            // sig verification) so a malformed cosig still reverts, but a valid
            // cosig over a stale firstNonce is skipped, not reverted. Read fresh
            // per iteration, so two batches for the same chain in one call work:
            // the first settles (advancing lastNonce), the second is then stale
            // and skipped. processVerifiedBatch keeps its own E86 require as a
            // defense-in-depth for any direct/buggy caller.
            if (batch.firstNonce != settlement.lastNonce(batch.user, batch.campaignId, batch.claims[0].actionType) + 1) {
                result.rejectedCount += batch.claims.length;
                emit BatchSkippedStale(batch.user, batch.campaignId, batch.firstNonce, batch.claims.length, 1);
                continue;
            }

            // ── Forward to Settlement ───────────────────────────────────────
            IDatumSettlement.SettlementResult memory sub =
                settlement.processVerifiedBatch(batch.user, batch.campaignId, batch.firstNonce, batch.claims);
            result.settledCount  += sub.settledCount;
            result.rejectedCount += sub.rejectedCount;
            result.totalPaid     += sub.totalPaid;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Deterministic hash over all claims in a batch for EIP-712 signing.
    function _hashClaims(IDatumSettlement.Claim[] calldata claims) internal pure returns (bytes32) {
        // SLIM (#2): claims no longer carry a precomputed claimHash, so bind the
        // signature to a content hash of each slim claim (publisher, amounts,
        // type, and any proof fields). Off-chain signers must mirror this:
        // keccak(abi.encode(Claim)) per claim, then keccak of the concatenation.
        bytes32[] memory hashes = new bytes32[](claims.length);
        for (uint256 i = 0; i < claims.length; i++) {
            hashes[i] = keccak256(abi.encode(claims[i]));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @dev Returns claims[0].publisher (used as the canonical publisher for
    ///      the entire batch). Returns address(0) for an empty batch -- the
    ///      caller already rejects that with E28.
    function _batchPublisher(IDatumSettlement.Claim[] calldata claims) internal pure returns (address) {
        if (claims.length == 0) return address(0);
        return claims[0].publisher;
    }
}
