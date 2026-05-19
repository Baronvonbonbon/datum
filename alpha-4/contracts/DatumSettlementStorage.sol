// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumUpgradable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumClickRegistry.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumPaymentVault.sol";
import "./interfaces/IDatumTokenRewardVault.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/IDatumPeopleChainIdentity.sol";
import "./interfaces/IDatumPowEngine.sol";
import "./interfaces/IDatumPublisherReputation.sol";
import "./interfaces/IDatumNullifierRegistry.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";
import "./interfaces/IDatumMintCoordinator.sol";

/// @dev Forward-declared shape of DatumSettlementLogicB.processBatch.
///      Used by the shared `_delegateProcessBatch` helper on
///      DatumSettlementStorage so both DatumSettlement (dual-sig path)
///      and DatumSettlementLogicA (relay outer loops) can dispatch into
///      LogicB without importing the LogicB contract directly. Avoids
///      the circular import that would otherwise form (LogicB imports
///      the storage base; the base would import LogicB).
interface IDatumSettlementLogicB_processBatch {
    function processBatch(
        address user,
        uint256 campaignId,
        IDatumSettlement.Claim[] calldata claims,
        bool advertiserConsented
    ) external returns (uint256 settled, uint256 rejected, uint256 paid);
}

/// @title  DatumSettlementStorage
/// @notice Shared abstract storage base for DatumSettlement and the future
///         DatumSettlementLogicA / DatumSettlementLogicB contracts (phase
///         8d-2+ of the EIP-170 plan).
///
/// @dev    The library + DELEGATECALL pattern requires every participating
///         contract to declare the EXACT same storage layout. This abstract
///         base is the single source of truth for that layout: it inherits
///         the same non-interface chain DatumSettlement had pre-phase-1
///         (ReentrancyGuard + DatumUpgradable) so ancestor slots stay at
///         their original offsets, then declares every Settlement-owned
///         state variable in its original order.
///
/// @dev    IDatumSettlement is NOT inherited here. Interfaces contribute no
///         storage slots so the layout would be identical either way, but
///         pulling the interface in would force LogicA / LogicB to provide
///         concrete implementations of every settle entry point — which is
///         the opposite of what they are (DELEGATECALL targets, not
///         standalone settlement contracts). DatumSettlement re-declares
///         `is IDatumSettlement` on its own line so it remains the public
///         settlement ABI surface.
///
/// @dev    NAMING: state variables use an underscore prefix (`_foo`)
///         so DatumSettlement can expose them as `function foo()` external
///         getters without name-shadowing collisions. The trailing public
///         constants (MAX_BATCH_SIZE_CEILING etc.) stay un-prefixed since
///         constants don't collide with getters.
///
/// @dev    LAYOUT INVARIANT: never declare additional state in child
///         contracts. New state goes here. The storage-layout snapshot
///         test in test/settlement-layout.test.ts (added in phase 8d-5)
///         compiles every child and asserts identical layouts.
abstract contract DatumSettlementStorage is
    ReentrancyGuard,
    DatumUpgradable
{
    // ─────────────────────────────────────────────────────────────────────
    // Cross-contract references (one slot each, order preserved from the
    // pre-refactor DatumSettlement). Underscore prefix to avoid colliding
    // with the public getters DatumSettlement exposes.
    // ─────────────────────────────────────────────────────────────────────

    IDatumBudgetLedger      internal _budgetLedger;
    IDatumPaymentVault      internal _paymentVault;
    IDatumCampaignLifecycle internal _lifecycle;
    address                 internal _relayContract;
    /// @notice Demoted from `immutable` in phase 8d-1 so future
    ///         DatumSettlementLogic contracts can read this through shared
    ///         storage. Set once in DatumSettlement's constructor; no setter.
    IDatumPauseRegistry     internal _pauseRegistry;
    address                 internal _attestationVerifier;
    IDatumClaimValidator    internal _claimValidator;
    IDatumPublishers        internal _publishers;
    IDatumTokenRewardVault  internal _tokenRewardVault;
    IDatumCampaigns         internal _campaigns;
    IDatumPublisherStake    internal _publisherStake;
    address                 internal _advertiserStake;
    IDatumClickRegistry     internal _clickRegistry;

    // ── DATUM token mint -- carved out to DatumMintCoordinator (C8b) ────
    IDatumMintCoordinator internal _mintCoordinator;

    // ── BM-5 + FP-5 carve-outs (alpha-4 EIP-170) ────────────────────────
    IDatumSettlementRateLimiter internal _rateLimiter;
    IDatumNullifierRegistry     internal _nullifiers;

    // ── BM-8/BM-9 reputation -- carved out to DatumPublisherReputation ──
    IDatumPublisherReputation internal _reputation;

    // ── Settlement batch size (governable) ──────────────────────────────
    uint256 public constant MAX_BATCH_SIZE_CEILING = 200;
    uint256 internal _maxBatchSize = 50;

    // ── User-side policy ────────────────────────────────────────────────
    mapping(address => uint8) internal _userMinAssurance;
    mapping(address => uint8) internal _userMinIdentityLevel;
    IDatumPeopleChainIdentity internal _identityRegistry;
    mapping(address => mapping(address => bool)) internal _userBlocksPublisher;
    mapping(address => mapping(address => bool)) internal _userBlocksAdvertiser;
    mapping(address => bool) internal _userPaused;

    // ── PoW -- carved out to DatumPowEngine ─────────────────────────────
    IDatumPowEngine internal _powEngine;

    // ── History counter (per-user cumulative settled events) ────────────
    mapping(address => uint256) internal _userTotalSettled;

    // ── Per-claim chain state ───────────────────────────────────────────
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) internal _lastNonce;
    mapping(address => mapping(uint256 => mapping(uint8 => bytes32))) internal _lastClaimHash;

    // ── BM-2 per-user per-campaign counters ─────────────────────────────
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) internal _userCampaignSettled;
    uint256 public constant MAX_USER_EVENTS = 100000;

    // ── #1 per-user per-campaign per-window event tracker ───────────────
    mapping(address => mapping(uint256 => mapping(uint8 => mapping(uint256 => uint256))))
        internal _userCampaignWindowEvents;

    // ── Revenue split (DOT) ─────────────────────────────────────────────
    uint16  internal _userShareBps = 7500;
    uint16  public constant MIN_USER_SHARE_BPS = 5000;
    uint16  public constant MAX_USER_SHARE_BPS = 9000;
    uint256 internal constant BPS_DENOMINATOR = 10000;

    // ── BM-10 per-(user, campaign) settle interval gate ─────────────────
    uint16 internal _minClaimInterval;
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) internal _lastSettlementBlock;

    // ── L-7 global per-block circuit breaker ────────────────────────────
    uint256 internal _maxSettlementPerBlock;
    uint256 internal _cbBlock;
    uint256 internal _cbTotal;

    // ── Dual-sig carve-out (alpha-4 EIP-170, C8c) ───────────────────────
    address internal _dualSig;

    // ── Two-Logic split (alpha-4 EIP-170 phase 8d-2) ────────────────────
    // DatumSettlementLogicA and DatumSettlementLogicB carry the bytecode
    // that Settlement DELEGATECALLs into; both inherit this same storage
    // base so their layouts match Settlement's exactly. The pointers are
    // updated as a pair via Settlement.setLogic to keep the two Logic
    // contracts in lockstep — an A/B mismatch would corrupt storage at
    // the first cross-call. Default address(0) means the routing path
    // is dormant (Phase 2 has no functions routed yet).
    address internal _logicA;
    address internal _logicB;

    // Phase 8d hedge: once production governance has audited and approved
    // the deployed Logic pair, calling Settlement.lockLogic() flips this
    // flag and any future setLogic call reverts. Pattern matches the
    // existing lockLanes / lockSlashers / lockMintAuthority cluster.
    // Left false during alpha/beta so governance can rotate Logic during
    // testing; production fires lockLogic via the upgrade ladder.
    bool internal _logicLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    //
    // ClaimSettled + ClaimRejected stay declared on IDatumSettlement (the
    // storage base inherits it) so the interface keeps owning the public
    // settlement surface. Settlement and the future LogicA / LogicB all
    // emit the same event signature via that inherited declaration.
    // ─────────────────────────────────────────────────────────────────────

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);
    event RewardCreditFailed(uint256 indexed campaignId, address indexed user, address indexed token, uint256 amount);
    event BlocklistCheckFailed(uint256 indexed campaignId, address indexed publisher);
    event AssuranceLookupFailed(uint256 indexed campaignId);
    event BlocklistFailedClosed(uint256 indexed campaignId, address indexed publisher);
    event ZKAssuranceFailed(uint256 indexed campaignId, address indexed user);
    event UserBlocklistRejected(address indexed user, address indexed counterparty);
    event UserBlocksPublisherSet(address indexed user, address indexed publisher, bool blocked);
    event UserBlocksAdvertiserSet(address indexed user, address indexed advertiser, bool blocked);
    event UserPausedSet(address indexed user, bool paused);
    event UserShareBpsSet(uint16 bps);
    event UserMinIdentityLevelSet(address indexed user, uint8 level);
    event IdentityRegistrySet(address indexed registry);
    event UserMinAssuranceSet(address indexed user, uint8 level);
    event MaxBatchSizeSet(uint256 value);
    event MintCoordinatorSet(address indexed coordinator);
    event RateLimiterSet(address indexed limiter);
    event NullifierRegistrySet(address indexed registry);
    event ReputationContractSet(address indexed reputation);
    event PowEngineSet(address indexed engine);
    event DualSigSet(address indexed dualSig);
    event LogicSet(address indexed logicA, address indexed logicB);
    event LogicLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Shared types
    //
    // Memory-only struct; not state. Lives on the base so DatumSettlement
    // and DatumSettlementLogicB see the same definition. Aggregates one
    // batch's payouts before the per-batch creditSettlement call.
    // ─────────────────────────────────────────────────────────────────────

    struct BatchAggregate {
        uint256 total;
        uint256 publisherPayment;
        uint256 userPayment;
        uint256 protocolFee;
        address publisher;
        uint256 tokenReward;
        address rewardToken;
        uint256 rewardPerImpression;
        bool exhausted;
        uint256 campaignIdExhausted;
        uint256 eventsSettled;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Shared view helper
    //
    // Hoisted to the base so Settlement (auth check in settleClaims /
    // settleClaimsMulti) and LogicB (auth-mirror inside processBatch, if
    // ever needed) can both call it. Reads only state — no writes — so it
    // is safe under both direct call and DELEGATECALL contexts.
    // ─────────────────────────────────────────────────────────────────────

    function _isPublisherRelay(IDatumSettlement.Claim[] calldata claims)
        internal
        view
        returns (bool)
    {
        if (address(_publishers) == address(0) || claims.length == 0) return false;
        // SAFETY: fail-CLOSED on revert. Returning false means the caller
        //         falls back to the broader auth list (batch.user,
        //         relayContract, attestationVerifier). The opposite
        //         (returning true on revert) would let a captured
        //         Publishers upgrade unilaterally authorize any settler
        //         as a "publisher relay" by reverting relaySigner().
        try _publishers.relaySigner(claims[0].publisher) returns (address pubRelay) {
            return pubRelay != address(0) && msg.sender == pubRelay;
        } catch {
            return false;
        }
    }

    /// @dev Pure assurance-gate decision (phase 8d hedge #5). Extracted out
    ///      of the per-batch inner loop so the gradient is auditable in
    ///      isolation. Inputs are pre-resolved by the caller (the
    ///      `msg.sender == relayContract` check and the `_isPublisherRelay`
    ///      view aren't pure, so they're passed in as booleans).
    ///
    ///      Returns (accept=true, 0) when the submission path satisfies the
    ///      effective level. Returns (accept=false, reasonCode) for the
    ///      specific rejection variant:
    ///        - reasonCode 24: effective level is L2 (DualSigned) and
    ///                         advertiserConsented is false. Only the dual-
    ///                         sig path (Settlement.processVerifiedBatch via
    ///                         DatumDualSigSettlement) can satisfy L2.
    ///        - reasonCode 25: effective level is L1 (PublisherSigned) and
    ///                         neither the relay path nor a publisher's own
    ///                         relaySigner is the submitter.
    ///
    ///      Effective level is the OR-merge `max(campaignLevel,
    ///      userMinAssurance)` -- a user can demand higher assurance than
    ///      the campaign offers (B5-fix); the campaign cannot demand less
    ///      than the user's floor.
    ///
    ///      The dual-sig path satisfies EVERY level by definition: both
    ///      publisher and advertiser have signed off-chain. Bail early so
    ///      the L2 branch doesn't reject a legitimate dual-sig batch.
    function _assuranceDecision(
        uint8 campaignLevel,
        uint8 userMinAssurance,
        bool advertiserConsented,
        bool fromRelay,
        bool fromPublisherRelay
    ) internal pure returns (bool accept, uint8 reasonCode) {
        if (advertiserConsented) return (true, 0);

        uint8 level = campaignLevel;
        if (userMinAssurance > level) level = userMinAssurance;

        if (level >= 2) return (false, 24);

        if (level == 1) {
            if (fromRelay || fromPublisherRelay) return (true, 0);
            return (false, 25);
        }

        // level == 0: any path accepted.
        return (true, 0);
    }

    /// @dev Forward one batch into DatumSettlementLogicB via DELEGATECALL.
    ///      Shared between DatumSettlement (dual-sig path) and
    ///      DatumSettlementLogicA (relay outer loops) so both invoke the
    ///      inner pipeline through one well-tested helper. LogicB inherits
    ///      this same storage base so its `processBatch` SLOAD/SSTORE
    ///      operations hit the original caller's storage.
    function _delegateProcessBatch(
        address user,
        uint256 campaignId,
        IDatumSettlement.Claim[] calldata claims,
        bool advertiserConsented,
        IDatumSettlement.SettlementResult memory result
    ) internal {
        address target = _logicB;
        if (target == address(0)) revert E00();
        (bool ok, bytes memory ret) = target.delegatecall(
            abi.encodeCall(
                IDatumSettlementLogicB_processBatch.processBatch,
                (user, campaignId, claims, advertiserConsented)
            )
        );
        if (!ok) {
            // Bubble the original revert reason so call sites see the
            // same Custom Error / require string an inlined call would
            // have produced.
            assembly {
                let size := mload(ret)
                revert(add(ret, 0x20), size)
            }
        }
        (uint256 s, uint256 r, uint256 p) = abi.decode(ret, (uint256, uint256, uint256));
        result.settledCount  += s;
        result.rejectedCount += r;
        result.totalPaid     += p;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Errors used by Settlement + (in phase 8d-2+) the Logic contracts.
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error E18();
    error E28();
    error E32();
    error E34();
    error E80();
    error E81();
    error E82();
    error E83();
    error E84();
    error E85();
    error AboveCap();
    error AlreadySet();
    error IsFrozen();
    error Paused();
    error OnlyDualSig();
}
