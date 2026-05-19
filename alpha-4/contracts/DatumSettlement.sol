// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// EIP712 + ECDSA moved to DatumDualSigSettlement (alpha-4 EIP-170 carve-out).
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

/// IDatumMintAuthority_Settle / IDatumEmissionEngine interface refs moved
/// to DatumMintCoordinator (alpha-4 EIP-170 carve-out). Settlement now
/// holds a single mintCoordinator pointer and calls `coordinate` once
/// per batch.

/// @dev #1 (2026-05-12): minimal Campaigns view for the per-user per-campaign
///      cap. Inline to avoid touching the IDatumCampaigns interface during
///      staged migration. Older deployments without these getters simply
///      revert and the try/catch above skips the cap.
interface ICampaignsUserCapView {
    function userEventCapPerWindow(uint256 campaignId) external view returns (uint32);
    function userCapWindowBlocks(uint256 campaignId) external view returns (uint32);
}

/// @title DatumSettlement
/// @notice Processes claim batches and distributes payments.
///
///         Alpha-3 multi-pricing changes:
///           - Claim struct: impressionCount→eventCount, clearingCpmPlanck→ratePlanck,
///             plus actionType, clickSessionHash, actionSig fields.
///           - Chain state triple-keyed: (user, campaignId, actionType).
///           - Payment formula: view (type-0) = (ratePlanck × eventCount) / 1000;
///             click/action (type-1/2) = ratePlanck × eventCount.
///           - BudgetLedger.deductAndTransfer now takes actionType.
///           - Type-1 claims: Settlement calls clickRegistry.markClaimed after success.
///           - rateLimiter.checkAndIncrement now takes actionType.
///
///         Revenue formula:
///           totalPayment    = (ratePlanck × eventCount / 1000) for view
///                           = (ratePlanck × eventCount) for click/action
///           publisherPayment = totalPayment × snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder × 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, DatumUpgradable {
    // ── Custom errors (mainnet-size: replaces require strings) ──
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

    function version() public pure override returns (uint256) { return 1; }

    IDatumBudgetLedger public budgetLedger;
    IDatumPaymentVault public paymentVault;
    IDatumCampaignLifecycle public lifecycle;
    address public relayContract;
    /// @dev Demoted from `immutable` in alpha-4 EIP-170 phase 8d-1. The
    ///      DatumSettlementLogic contracts (added in phase 8d-2+) share
    ///      Settlement's storage via DELEGATECALL and need to read this
    ///      value through a normal storage slot rather than a value baked
    ///      into Settlement's own runtime bytecode. Set once in the
    ///      constructor; no setter, no way to re-point.
    IDatumPauseRegistry public pauseRegistry;
    address public attestationVerifier;
    IDatumClaimValidator public claimValidator;
    // S12: publishers ref for settlement-level blocklist check (address(0) = disabled)
    IDatumPublishers public publishers;
    // Token reward vault (address(0) = no token rewards)
    IDatumTokenRewardVault public tokenRewardVault;
    // Campaigns ref for reading reward token config
    IDatumCampaigns public campaigns;
    // FP-1: optional publisher stake enforcement (address(0) = disabled)
    IDatumPublisherStake public publisherStake;

    /// @notice CB4: advertiser-side stake contract. When non-zero, Settlement
    ///         calls recordBudgetSpent on each settled batch so the bonding
    ///         curve advances. Lock-once below.
    address public advertiserStake;
    // CPC: click registry for type-1 session tracking (address(0) = disabled)
    IDatumClickRegistry public clickRegistry;

    // ── DATUM token mint — carved out to DatumMintCoordinator ───────────
    // Mint authority, emission engine pointer, legacy flat-rate fallback,
    // dust threshold, reward split bps, and the per-batch orchestration
    // logic all moved to DatumMintCoordinator (alpha-4 EIP-170 carve-out).
    // Settlement holds one lock-once pointer and calls coordinate() once
    // per batch at the end of _processBatch. The coordinator runs the
    // engine-or-fallback path, applies the dust gate, splits the result,
    // and delegates the actual mint to the wired MintAuthority.
    IDatumMintCoordinator public mintCoordinator;
    event MintCoordinatorSet(address indexed coordinator);

    // ── BM-5: Rate limiter — carved out to DatumSettlementRateLimiter ──
    // ── FP-5: Nullifier registry — carved out to DatumNullifierRegistry ──
    // Both were alpha-3 satellites that got merged in for PVM bytecode
    // pressure; un-merged for mainnet EIP-170. Settlement keeps lock-once
    // pointers and consults each module per claim.
    IDatumSettlementRateLimiter public rateLimiter;
    IDatumNullifierRegistry public nullifiers;
    event RateLimiterSet(address indexed limiter);
    event NullifierRegistrySet(address indexed registry);

    // ── BM-8/BM-9: Publisher reputation — carved out to DatumPublisherReputation
    // Reputation state, the per-publisher acceptance counters, and the
    // anomaly views moved to DatumPublisherReputation so the module can be
    // upgraded independently. Settlement calls canSettle() before
    // processing a batch and recordSettlement() at the end. The pointer is
    // lock-once; address(0) disables the gate (and recording) entirely.
    IDatumPublisherReputation public reputation;
    event ReputationContractSet(address indexed reputation);

    // ── Settlement batch size (governable, was hard-coded 10 in alpha-3) ──
    // Original cap was 10 due to PVM cross-contract staticcall weight pressure.
    // Alpha-4 satellite merge eliminated those staticcalls, and the EVM gas
    // budget comfortably fits much larger batches. Governance can re-tune via
    // setMaxBatchSize, bounded by MAX_BATCH_SIZE_CEILING.
    uint256 public constant MAX_BATCH_SIZE_CEILING = 200;
    uint256 public maxBatchSize = 50;
    event MaxBatchSizeSet(uint256 value);

    // B5-fix (2026-05-12): per-user minimum acceptable AssuranceLevel. A user
    // writes their own floor (0..2) and Settlement rejects batches addressed to
    // that user when the campaign's effective AssuranceLevel is below it. This
    // extends the AssuranceLevel choice from advertiser-only to user-as-well:
    // users can refuse low-proof settlement (e.g. demand publisher cosig) on
    // their own behalf without relying on each campaign's advertiser to opt in.
    // Default 0 = accept any level (current behavior). Self-set only.
    mapping(address => uint8) public userMinAssurance;

    /// @notice People Chain identity gate (user-side floor). Symmetric to the
    ///         campaign-side `campaignMinIdentityLevel` — the user can demand
    ///         that any campaign they settle on must require identity at this
    ///         minimum level. The effective gate is the OR-merge:
    ///             effectiveMinLevel = max(campaignMinIdentityLevel, userMinIdentityLevel)
    ///         0 = disabled (default). Self-set only.
    mapping(address => uint8) public userMinIdentityLevel;
    event UserMinIdentityLevelSet(address indexed user, uint8 level);

    /// @notice People Chain identity cache. Settlement queries `isVerified` on
    ///         the hot path. Set once via `setIdentityRegistry` (lock-once;
    ///         hot-swapping the identity source mid-flight would let an
    ///         attacker rotate to a permissive cache and bypass the gate).
    ///         Address(0) means the identity gate is dormant: any non-zero
    ///         effective-min-level reverts batches CLOSED — operators must
    ///         wire the registry before any campaign or user opts in.
    IDatumPeopleChainIdentity public identityRegistry;
    event IdentityRegistrySet(address indexed registry);

    /// @notice CB1: per-user counterparty blocklists. Self-set; only the user
    ///         themselves can mutate. Checked in _processBatch — any batch
    ///         routed to a user who has blocked the counterparty is rejected
    ///         regardless of AssuranceLevel. Symmetric to the publisher's
    ///         per-advertiser allowlist.
    mapping(address => mapping(address => bool)) public userBlocksPublisher;
    mapping(address => mapping(address => bool)) public userBlocksAdvertiser;

    /// @notice CB2: per-user self-pause flag. Self-set; only the user. While
    ///         true, every settlement to this user is rejected — a kill-switch
    ///         the user can hit during suspected key compromise without
    ///         needing protocol-level action.
    mapping(address => bool) public userPaused;
    event UserMinAssuranceSet(address indexed user, uint8 level);

    // -------------------------------------------------------------------------
    // #5: Per-impression PoW — carved out to DatumPowEngine
    // -------------------------------------------------------------------------
    // PoW state, difficulty curve, admin, and views moved to DatumPowEngine
    // so the module can be upgraded independently and Settlement fits under
    // EIP-170. Settlement keeps a pointer and calls `consumeFor` once per
    // batch in `_processBatch`. ClaimValidator reads `enforcePow` and
    // `powTargetForUser` directly from the engine.
    IDatumPowEngine public powEngine;
    event PowEngineSet(address indexed engine);

    // #2-extension (2026-05-12): cumulative settled events per user, all
    // campaigns + actionTypes. Drives per-campaign minUserSettledHistory
    // filters (proof-of-on-chain-history as a soft sybil bar).
    mapping(address => uint256) public userTotalSettled;

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);
    /// @notice L-4: Emitted when the non-critical token-reward credit reverts so off-chain
    ///         monitors can flag mis-wired or under-funded reward configs.
    event RewardCreditFailed(uint256 indexed campaignId, address indexed user, address indexed token, uint256 amount);
    /// @notice A4-fix: Emitted when publishers.isBlocked() reverts during a batch.
    ///         Advisory only — settlement continues. Monitors should re-wire / fix the
    ///         publishers ref. Not a rejection.
    event BlocklistCheckFailed(uint256 indexed campaignId, address indexed publisher);

    /// @notice H2-fix: emitted when the AssuranceLevel lookup on Campaigns
    ///         reverts. The batch is failed CLOSED (treated as max-enforced),
    ///         but operators should see this and repair the Campaigns wiring.
    event AssuranceLookupFailed(uint256 indexed campaignId);

    /// @notice M2-fix: emitted when an L1+ campaign's blocklist lookup reverts.
    ///         At L1 or above the batch is rejected; at L0 it falls through
    ///         (advisory BlocklistCheckFailed above).
    event BlocklistFailedClosed(uint256 indexed campaignId, address indexed publisher);

    /// @notice M1-fix: emitted when an L3 campaign settles without a valid ZK
    ///         proof. The user opted in to ZK-only settlement via userMinAssurance=3.
    event ZKAssuranceFailed(uint256 indexed campaignId, address indexed user);

    /// @notice CB1: emitted when a user's self-managed blocklist rejects a batch.
    event UserBlocklistRejected(address indexed user, address indexed counterparty);
    event UserBlocksPublisherSet(address indexed user, address indexed publisher, bool blocked);
    event UserBlocksAdvertiserSet(address indexed user, address indexed advertiser, bool blocked);

    /// @notice CB2: emitted on user self-pause toggle.
    event UserPausedSet(address indexed user, bool paused);

    // Triple-keyed chain state: (user, campaignId, actionType)
    mapping(address => mapping(uint256 => mapping(uint8 => uint256)))  public lastNonce;
    mapping(address => mapping(uint256 => mapping(uint8 => bytes32))) public lastClaimHash;

    // BM-2: Per-user per-campaign per-actionType cumulative settlement tracking
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public userCampaignSettled;
    uint256 public constant MAX_USER_EVENTS = 100000;

    // #1 (2026-05-12): Per-user per-campaign per-actionType per-window event
    // counter. Window length is per-campaign (Campaigns.userCapWindowBlocks).
    // windowId = block.number / windowBlocks.
    mapping(address => mapping(uint256 => mapping(uint8 => mapping(uint256 => uint256))))
        public userCampaignWindowEvents;

    // M-1: Revenue split — user gets `userShareBps / 10000` of remainder after
    //      publisher take rate. Governance-tunable within [MIN_USER_SHARE_BPS,
    //      MAX_USER_SHARE_BPS] via setUserShareBps. Defaults to 75%.
    uint16 public userShareBps = 7500;
    uint16 public constant MIN_USER_SHARE_BPS = 5000;   // floor protects user payout from dropping below 50% of remainder
    uint16 public constant MAX_USER_SHARE_BPS = 9000;   // ceiling preserves a minimum 10% protocol fee
    event UserShareBpsSet(uint16 bps);
    uint256 private constant BPS_DENOMINATOR = 10000;

    // BM-10: Minimum blocks between settlement batches per user per campaign (0 = disabled)
    uint16 public minClaimInterval;
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public lastSettlementBlock;

    // L-7: Global per-block settlement circuit breaker (0 = disabled)
    uint256 public maxSettlementPerBlock;

    // A1+A9: EIP-712 typehash binds the relay-signer the publisher expected at
    // sign time + a block-number deadline (parity with DatumRelay). Both
    // protect against state mutations between sign and submit:
    //   - relaySigner: if the publisher rotates their relay key after signing,
    //     submission fails — the advertiser's cosig is over a *specific* publisher
    //     authority, not whoever the publishers contract returns at exec time.
    //   - deadlineBlock: block.number is cheaper to predict than block.timestamp
    //     and removes the unit-ambiguity vs. the Relay path.
    // CLAIM_BATCH_TYPEHASH + EIP712 base moved to DatumDualSigSettlement
    // (alpha-4 EIP-170 carve-out). Settlement no longer hashes / recovers
    // signatures itself; the DualSig contract does both and then calls
    // `processVerifiedBatch` below.
    uint256 private _cbBlock;
    uint256 private _cbTotal;

    /// @notice The carved-out DualSig settlement module. Set once via
    ///         `setDualSig` (lock-once). When non-zero, this is the only
    ///         caller allowed to invoke `processVerifiedBatch`.
    address public dualSig;
    event DualSigSet(address indexed dualSig);
    error OnlyDualSig();

    constructor(address _pauseRegistry) {
        if (!(_pauseRegistry != address(0))) revert E00();
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev B8-fix (2026-05-12): structural references are lock-once. Settlement
    ///      cannot have its budget ledger, payment vault, lifecycle, or relay
    ///      hot-swapped post-bootstrap — every swap point is a rug surface and
    ///      none of these have a legitimate change reason once wired. Deploy a
    ///      fresh Settlement if you genuinely need to re-point.
    function configure(
        address _budgetLedger,
        address _paymentVault,
        address _lifecycle,
        address _relay
    ) external onlyOwner {
        if (!(address(budgetLedger) == address(0))) revert AlreadySet();
        if (!(_budgetLedger != address(0))) revert E00();
        if (!(_paymentVault != address(0))) revert E00();
        if (!(_lifecycle != address(0))) revert E00();
        if (!(_relay != address(0))) revert E00();
        budgetLedger = IDatumBudgetLedger(_budgetLedger);
        paymentVault = IDatumPaymentVault(_paymentVault);
        lifecycle = IDatumCampaignLifecycle(_lifecycle);
        relayContract = _relay;
        emit SettlementConfigured(_budgetLedger, _paymentVault, _lifecycle, _relay);
    }

    /// @dev Cypherpunk lock-once: validators are settlement-critical. A malicious
    ///      owner swap to a permissive validator is the single largest rug
    ///      surface (fake rates → drain budgets). One write, then frozen.
    function setClaimValidator(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(claimValidator) == address(0))) revert AlreadySet();
        claimValidator = IDatumClaimValidator(addr);
    }

    /// @dev Cypherpunk lock-once: same rationale as setClaimValidator —
    ///      a swappable attestation verifier lets an owner forge dual-sig.
    function setAttestationVerifier(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(attestationVerifier == address(0))) revert AlreadySet();
        attestationVerifier = addr;
    }

    /// @notice Wire the carved-out rate limiter module. Lock-once.
    function setRateLimiter(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (address(rateLimiter) != address(0)) revert AlreadySet();
        rateLimiter = IDatumSettlementRateLimiter(addr);
        emit RateLimiterSet(addr);
    }

    function setMinClaimInterval(uint16 interval) external onlyOwner {
        minClaimInterval = interval;
    }

    /// @dev Cypherpunk lock-once: publishers ref drives blocklist + stake gates.
    ///      A swap could silently disable those (point to a permissive contract).
    ///      address(0) is a valid initial state ("feature off"); once set non-zero
    ///      it is frozen for the life of this Settlement.
    function setPublishers(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(publishers) == address(0))) revert AlreadySet();
        publishers = IDatumPublishers(addr);
    }

    /// @dev D3: Cypherpunk lock-once on optional feature. tokenRewardVault holds
    ///      advertiser-deposited ERC20s; a hot-swap could redirect credit() to
    ///      a hostile vault that quietly absorbs rewards. address(0) leaves the
    ///      feature off; once set non-zero it's frozen.
    function setTokenRewardVault(address addr) external onlyOwner {
        if (!(address(tokenRewardVault) == address(0))) revert AlreadySet();
        tokenRewardVault = IDatumTokenRewardVault(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        // B8-fix: structural ref, lock-once.
        if (!(address(campaigns) == address(0))) revert AlreadySet();
        if (!(addr != address(0))) revert E00();
        campaigns = IDatumCampaigns(addr);
    }

    /// @dev Cypherpunk lock-once: stake adequacy gate. Hot-swap could neuter it.
    function setPublisherStake(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(publisherStake) == address(0))) revert AlreadySet();
        publisherStake = IDatumPublisherStake(addr);
    }

    /// @dev CB4 lock-once: advertiser-stake callback target. Hot-swap could
    ///      forge budget-spent on rivals to drive their required-stake up.
    function setAdvertiserStake(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(advertiserStake == address(0))) revert AlreadySet();
        advertiserStake = addr;
    }

    /// @notice Wire the carved-out nullifier-registry module. Lock-once.
    function setNullifierRegistry(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (address(nullifiers) != address(0)) revert AlreadySet();
        nullifiers = IDatumNullifierRegistry(addr);
        emit NullifierRegistrySet(addr);
    }

    function setMaxBatchSize(uint256 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_BATCH_SIZE_CEILING)) revert E11();
        maxBatchSize = v;
        emit MaxBatchSizeSet(v);
    }

    /// @notice Wire the carved-out reputation module. Lock-once.
    function setReputationContract(address rep) external onlyOwner {
        if (rep == address(0)) revert E00();
        if (address(reputation) != address(0)) revert AlreadySet();
        reputation = IDatumPublisherReputation(rep);
        emit ReputationContractSet(rep);
    }

    /// @notice B5-fix + M1-fix: user sets their own minimum AssuranceLevel
    ///         floor (0..3). Self-only; no admin or counterparty can lower or raise.
    ///         0 = accept any (default).
    ///         1 = require publisher cosig (relay path or publisher's own relay).
    ///         2 = require dual-sig (publisher + advertiser EIP-712 cosig).
    ///         3 = require dual-sig AND campaign must require valid ZK proofs.
    function setUserMinAssurance(uint8 level) external whenNotFrozen {
        if (!(level <= 3)) revert E11();
        userMinAssurance[msg.sender] = level;
        emit UserMinAssuranceSet(msg.sender, level);
    }

    /// @notice User-side People Chain identity floor (0/1/2). Mirrors
    ///         `setUserMinAssurance`: self-only, instant effect, no admin
    ///         override. The effective gate in `_processBatch` is
    ///         `max(campaignMinIdentityLevel, userMinIdentityLevel)`.
    function setUserMinIdentityLevel(uint8 level) external whenNotFrozen {
        if (!(level <= 2)) revert E11();
        userMinIdentityLevel[msg.sender] = level;
        emit UserMinIdentityLevelSet(msg.sender, level);
    }

    /// @notice Wire the People Chain identity cache. Lock-once: rotating the
    ///         identity source after deploy would let a captured owner point
    ///         at a permissive registry and bypass every campaign's identity
    ///         gate in flight. Redeploy Settlement if rotation is needed.
    function setIdentityRegistry(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(identityRegistry) == address(0))) revert AlreadySet();
        identityRegistry = IDatumPeopleChainIdentity(addr);
        emit IdentityRegistrySet(addr);
    }

    /// @notice CB1: self-managed publisher blocklist. Caller is the user.
    ///         Blocked publishers cannot settle claims to this user.
    function setUserBlocksPublisher(address publisher, bool blocked) external whenNotFrozen {
        if (!(publisher != address(0))) revert E00();
        userBlocksPublisher[msg.sender][publisher] = blocked;
        emit UserBlocksPublisherSet(msg.sender, publisher, blocked);
    }

    /// @notice CB1: self-managed advertiser blocklist. Caller is the user.
    function setUserBlocksAdvertiser(address advertiser, bool blocked) external whenNotFrozen {
        if (!(advertiser != address(0))) revert E00();
        userBlocksAdvertiser[msg.sender][advertiser] = blocked;
        emit UserBlocksAdvertiserSet(msg.sender, advertiser, blocked);
    }

    /// @notice CB2: user self-pause kill switch. While true, no batches settle
    ///         to this user regardless of submission path or AssuranceLevel.
    ///         Self-set; only the user.
    function setUserPaused(bool paused_) external whenNotFrozen {
        userPaused[msg.sender] = paused_;
        emit UserPausedSet(msg.sender, paused_);
    }

    // -------------------------------------------------------------------------
    // #5: PoW — moved to DatumPowEngine
    // -------------------------------------------------------------------------

    /// @notice Wire the carved-out PoW engine. Lock-once.
    function setPowEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert E00();
        if (address(powEngine) != address(0)) revert AlreadySet();
        powEngine = IDatumPowEngine(engine);
        emit PowEngineSet(engine);
    }

    function setClickRegistry(address addr) external onlyOwner {
        // A13: lock once set. Re-pointing to a fresh registry would create a
        // replay window for already-claimed click sessions. Deploy a new
        // Settlement if a registry swap is genuinely required.
        if (!(address(clickRegistry) == address(0))) revert AlreadySet();
        if (!(addr != address(0))) revert E00();
        clickRegistry = IDatumClickRegistry(addr);
    }

    /// @notice L-7: Set global per-block settlement cap in planck. 0 = disabled.
    function setMaxSettlementPerBlock(uint256 cap) external onlyOwner {
        maxSettlementPerBlock = cap;
    }

    /// @notice One-time wiring of the carved-out mint coordinator. Lock-once.
    function setMintCoordinator(address coordinator) external onlyOwner {
        if (coordinator == address(0)) revert E00();
        if (address(mintCoordinator) != address(0)) revert AlreadySet();
        mintCoordinator = IDatumMintCoordinator(coordinator);
        emit MintCoordinatorSet(coordinator);
    }

    // setMintAuthority / setEmissionEngine / setMintRate / setDustMintThreshold /
    // setDatumRewardSplit moved to DatumMintCoordinator.

    /// @notice Governance: set the user's share of `remainder` (after publisher
    ///         take rate). Bounded to [MIN_USER_SHARE_BPS, MAX_USER_SHARE_BPS]
    ///         so neither user nor protocol can be governance-pushed to 0.
    function setUserShareBps(uint16 bps) external onlyOwner {
        if (!(bps >= MIN_USER_SHARE_BPS && bps <= MAX_USER_SHARE_BPS)) revert E11();
        userShareBps = bps;
        emit UserShareBpsSet(bps);
    }

    // setDatumRewardSplit moved to DatumMintCoordinator.

    receive() external payable { revert("E03"); }

    // -------------------------------------------------------------------------
    // H-7: Configuration validation
    // -------------------------------------------------------------------------

    /// @notice Check that all required references are configured. Returns (valid, missingField).
    ///         Call after deploy/wiring as a smoke test.
    function validateConfiguration() external view returns (bool valid, string memory missingField) {
        if (address(budgetLedger) == address(0)) return (false, "budgetLedger");
        if (address(paymentVault) == address(0)) return (false, "paymentVault");
        if (address(lifecycle) == address(0)) return (false, "lifecycle");
        if (relayContract == address(0)) return (false, "relayContract");
        if (address(pauseRegistry) == address(0)) return (false, "pauseRegistry");
        if (address(claimValidator) == address(0)) return (false, "claimValidator");
        if (address(campaigns) == address(0)) return (false, "campaigns");
        // A1: off-chain ZK clients derive windowId via the nullifier registry's
        // configured window. Require both the registry wired AND its window set
        // when the verifier path is in play (claimValidator implies ZK).
        if (address(nullifiers) == address(0)) return (false, "nullifiers");
        if (nullifiers.nullifierWindowBlocks() == 0) return (false, "nullifierWindowBlocks");
        // Optional references (address(0) = disabled feature, not misconfigured):
        // publishers, tokenRewardVault, publisherStake, clickRegistry,
        // attestationVerifier, rateLimiter, reputation, powEngine
        return (true, "");
    }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        whenNotFrozen
        returns (SettlementResult memory result)
    {
        if (!(address(claimValidator) != address(0))) revert E00();

        if (!(!pauseRegistry.pausedSettlement())) revert Paused();

        if (!(batches.length <= maxBatchSize)) revert E28();

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            bool isPublisherRelay = _isPublisherRelay(batch.claims);

            if (!(msg.sender == batch.user || msg.sender == relayContract || msg.sender == attestationVerifier || isPublisherRelay)) revert E32();
            _processBatch(batch.user, batch.campaignId, batch.claims, result, false);
        }
    }

    /// @inheritdoc IDatumSettlement
    function settleClaimsMulti(UserClaimBatch[] calldata batches)
        external
        nonReentrant
        whenNotFrozen
        returns (SettlementResult memory result)
    {
        if (!(address(claimValidator) != address(0))) revert E00();

        if (!(!pauseRegistry.pausedSettlement())) revert Paused();

        if (!(batches.length <= maxBatchSize)) revert E28();

        for (uint256 u = 0; u < batches.length; u++) {
            UserClaimBatch calldata ub = batches[u];
            if (!(ub.campaigns.length <= maxBatchSize)) revert E28();

            for (uint256 c = 0; c < ub.campaigns.length; c++) {
                CampaignClaims calldata cc = ub.campaigns[c];

                bool isPublisherRelay = _isPublisherRelay(cc.claims);

                if (!(msg.sender == ub.user || msg.sender == relayContract || msg.sender == attestationVerifier || isPublisherRelay)) revert E32();

                _processBatch(ub.user, cc.campaignId, cc.claims, result, false);
            }
        }
    }

    /// @notice Wire the carved-out DualSig settlement module. Lock-once.
    function setDualSig(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (dualSig != address(0)) revert AlreadySet();
        dualSig = addr;
        emit DualSigSet(addr);
    }

    /// @inheritdoc IDatumSettlement
    /// @dev Called by DatumDualSigSettlement after both EIP-712 signatures
    ///      have been verified. Gated to `dualSig` so no other contract or
    ///      EOA can invoke the dual-sig settle path.
    function processVerifiedBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims
    ) external nonReentrant whenNotFrozen returns (SettlementResult memory result) {
        if (msg.sender != dualSig) revert OnlyDualSig();
        if (address(claimValidator) == address(0)) revert E00();
        if (pauseRegistry.pausedSettlement()) revert Paused();
        if (claims.length == 0) revert E28();
        if (claims.length > maxBatchSize) revert E28();
        _processBatch(user, campaignId, claims, result, true);
    }

    function _isPublisherRelay(Claim[] calldata claims) internal view returns (bool) {
        if (address(publishers) == address(0) || claims.length == 0) return false;
        try publishers.relaySigner(claims[0].publisher) returns (address pubRelay) {
            return pubRelay != address(0) && msg.sender == pubRelay;
        } catch {
            return false;
        }
    }

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

    function _processBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims,
        SettlementResult memory result,
        bool advertiserConsented
    ) internal {
        if (!(claims.length <= maxBatchSize)) revert E28();

        // CB2 (2026-05-13): user self-pause kill switch. Reject the whole
        // batch when the user has paused their own account — emits per-claim
        // ClaimRejected so observers can see the cause.
        if (userPaused[user]) {
            for (uint256 j = 0; j < claims.length; j++) {
                result.rejectedCount++;
                emit ClaimRejected(campaignId, user, claims[j].nonce, 27);
            }
            return;
        }

        // CB1: user-side advertiser blocklist. Advertiser is per-campaign, so
        // we can check at batch entry (one read per batch). Publisher block
        // happens per-claim below since the publisher can vary per claim.
        if (address(campaigns) != address(0)) {
            address adv = campaigns.getCampaignAdvertiser(campaignId);
            if (adv != address(0) && userBlocksAdvertiser[user][adv]) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 28);
                }
                emit UserBlocklistRejected(user, adv);
                return;
            }
        }

        // M1-fix (2026-05-13): user-floor L3 = ZK-only. Applies regardless of
        // submission path (relay, publisher-relay, dual-sig). The user opted
        // in to ZK-verified settlement for themselves; an advertiser cosig
        // does NOT satisfy this floor. Reject if campaign doesn't require ZK.
        if (userMinAssurance[user] >= 3 && address(campaigns) != address(0)) {
            bool reqZk = false;
            try campaigns.getCampaignRequiresZkProof(campaignId) returns (bool z) {
                reqZk = z;
            } catch {
                // Fail closed on unreadable ZK flag — same gradient logic as H2.
                reqZk = false;
            }
            if (!reqZk) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ZKAssuranceFailed(campaignId, user);
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 26);
                }
                return;
            }
        }

        // People Chain identity gate (2026-05-16). Effective minimum identity
        // level is the OR-merge of the campaign-side and user-side floors.
        // When non-zero, the user MUST have a non-expired cached attestation
        // at >= that level in DatumPeopleChainIdentity, regardless of which
        // submission path is in use (relay, dual-sig, publisher-relay).
        //
        // Fail-CLOSED on (a) unreadable Campaigns ref and (b) identity
        // registry unwired — matches H2-fix gradient: a misconfiguration
        // can't silently downgrade an identity-gated campaign to no gate.
        {
            uint8 campaignMinId = 0;
            if (address(campaigns) != address(0)) {
                // Default to max enforced on revert so a broken Campaigns ref
                // can't downgrade a KnownGood gate to None.
                campaignMinId = 2;
                try campaigns.getCampaignMinIdentityLevel(campaignId) returns (uint8 lvl) {
                    campaignMinId = lvl;
                } catch {
                    // Use existing AssuranceLookupFailed signal — same root cause.
                    emit AssuranceLookupFailed(campaignId);
                }
            }
            uint8 userMinId = userMinIdentityLevel[user];
            uint8 effMinId = campaignMinId > userMinId ? campaignMinId : userMinId;
            if (effMinId > 0) {
                bool ok = false;
                if (address(identityRegistry) != address(0)) {
                    try identityRegistry.isVerified(user, effMinId) returns (bool v) {
                        ok = v;
                    } catch {
                        ok = false; // fail closed
                    }
                }
                if (!ok) {
                    for (uint256 j = 0; j < claims.length; j++) {
                        result.rejectedCount++;
                        emit ClaimRejected(campaignId, user, claims[j].nonce, 30);
                    }
                    return;
                }
            }
        }

        // M2-fix (2026-05-13): compute the effective campaign level once for
        // use by both the assurance gate AND the per-claim blocklist gate
        // below. Dual-sig batches satisfy the path requirement but still need
        // a level value so the blocklist gate can choose fail-open (L0) vs
        // fail-closed (L1+).
        uint8 effectiveLevel = 0;
        if (address(campaigns) != address(0)) {
            // H2-fix (2026-05-13): fail CLOSED on revert. Default to max
            // enforced (2) so a misconfigured Campaigns ref can't silently
            // downgrade high-assurance campaigns to L0.
            effectiveLevel = 2;
            try campaigns.getCampaignAssuranceLevel(campaignId) returns (uint8 l) {
                effectiveLevel = l;
            } catch {
                emit AssuranceLookupFailed(campaignId);
            }
        }

        // A3: AssuranceLevel gate. Enforce that the submission path delivers
        // the required cryptographic proof. Levels nest: a dual-sig batch
        // (advertiserConsented=true) satisfies every level; the relay path /
        // publisher-relay msg.sender satisfies level 1.
        if (!advertiserConsented && address(campaigns) != address(0)) {
            uint8 level = effectiveLevel;

            // B5-fix: honor the user's own floor. If a user demands ≥L1 and the
            // campaign offers L0, treat the batch as if it required the user's
            // floor — reject. Permits each user to opt out of low-proof settlement
            // for themselves without protocol-wide policy changes.
            uint8 uMin = userMinAssurance[user];
            if (uMin > level) level = uMin;

            if (level >= 2) {
                // Level 2 (DualSigned) requires settleSignedClaims (this would have
                // set advertiserConsented). Reject everything else with reason 24.
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 24);
                }
                return;
            }

            if (level == 1) {
                // Level 1 (PublisherSigned) requires that a publisher sig has
                // been validated upstream. DatumRelay validates the publisher
                // cosig before forwarding to settleClaims, and the publisher's
                // own relaySigner submitting via settleClaims demonstrates
                // their authority directly. Reject any other path.
                bool fromRelay = (msg.sender == relayContract);
                bool fromPublisherRelay = _isPublisherRelay(claims);
                if (!fromRelay && !fromPublisherRelay) {
                    for (uint256 j = 0; j < claims.length; j++) {
                        result.rejectedCount++;
                        emit ClaimRejected(campaignId, user, claims[j].nonce, 25);
                    }
                    return;
                }
            }
        }

        // All claims in a batch must share the same actionType (validated by chain state key)
        // We read actionType from the first claim for batch-level checks
        uint8 batchActionType = 0;
        if (claims.length > 0) {
            batchActionType = claims[0].actionType;
        }

        // BM-10: Min claim interval
        uint16 interval = minClaimInterval;
        if (interval > 0) {
            uint256 lastBlock = lastSettlementBlock[user][campaignId][batchActionType];
            if (lastBlock != 0 && block.number < lastBlock + interval) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 18);
                }
                return;
            }
        }

        // Safe rollout: reputation gate (delegated to DatumPublisherReputation)
        if (address(reputation) != address(0) && claims.length > 0) {
            if (!reputation.canSettle(claims[0].publisher)) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(claims[j].campaignId, user, claims[j].nonce, 20);
                }
                return;
            }
        }

        uint256 prevSettledCount = result.settledCount;
        uint256 prevRejectedCount = result.rejectedCount;
        bool gapFound = false;

        BatchAggregate memory agg;

        // Cache token reward config once per batch (view claims only)
        if (claims.length > 0 && address(tokenRewardVault) != address(0) && address(campaigns) != address(0) && batchActionType == 0) {
            try campaigns.getCampaignRewardToken(campaignId) returns (address rt) {
                agg.rewardToken = rt;
                if (rt != address(0)) {
                    try campaigns.getCampaignRewardPerImpression(campaignId) returns (uint256 rpi) {
                        agg.rewardPerImpression = rpi;
                    } catch {}
                }
            } catch {}
        }

        for (uint256 i = 0; i < claims.length; i++) {
            Claim calldata claim = claims[i];

            if (claim.campaignId != campaignId) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 0);
                continue;
            }

            if (gapFound) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 1);
                continue;
            }

            // S12: Settlement-level blocklist check.
            // M2-fix (2026-05-13): trust gradient — fail-open at L0, fail-closed
            // at L1+. H-3 audit fix (2026-05-13): use isBlockedStrict at L1+ so
            // a curator revert actually reaches this try/catch (the fail-open
            // isBlocked variant swallowed reverts internally, making the
            // fail-closed branch unreachable). isBlocked (fail-open) still used
            // at L0 where liveness is preferred.
            if (address(publishers) != address(0)) {
                if (effectiveLevel >= 1) {
                    try publishers.isBlockedStrict(claim.publisher) returns (bool blocked) {
                        if (blocked) {
                            result.rejectedCount++;
                            emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                            gapFound = true;
                            continue;
                        }
                    } catch {
                        // Fail closed: blocklist gate is part of L1+ guarantees.
                        result.rejectedCount++;
                        emit BlocklistFailedClosed(claim.campaignId, claim.publisher);
                        emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                } else {
                    // L0: fail-open. publishers.isBlocked already swallows
                    // curator reverts and returns false, so no try/catch needed.
                    if (publishers.isBlocked(claim.publisher)) {
                        result.rejectedCount++;
                        emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                }
            }

            // CB1: per-claim publisher block from user's self-managed list.
            // Treated as a hard reject (gap-set) so chain state stays linear.
            if (userBlocksPublisher[user][claim.publisher]) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 28);
                emit UserBlocklistRejected(user, claim.publisher);
                gapFound = true;
                continue;
            }

            // Delegate validation to ClaimValidator satellite (SE-1)
            uint256 expectedNonce  = lastNonce[user][claim.campaignId][claim.actionType] + 1;
            bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId][claim.actionType];

            (bool ok, uint8 reasonCode, uint16 cTakeRate, bytes32 computedHash) =
                claimValidator.validateClaim(claim, user, expectedNonce, expectedPrevHash);

            if (!ok) {
                if (reasonCode == 7) gapFound = true;
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            // BM-2: Per-user settlement cap check (per actionType)
            uint256 newTotal = userCampaignSettled[user][claim.campaignId][claim.actionType] + claim.eventCount;
            if (newTotal > MAX_USER_EVENTS) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 13);
                gapFound = true;
                continue;
            }
            userCampaignSettled[user][claim.campaignId][claim.actionType] = newTotal;

            // #1: Per-user per-campaign per-window cap (advertiser-set).
            //     Cheap try/catch on the Campaigns view so older deployments
            //     without these knobs continue to settle normally.
            if (address(campaigns) != address(0)) {
                uint32 capMax;
                uint32 capWin;
                try ICampaignsUserCapView(address(campaigns)).userEventCapPerWindow(claim.campaignId) returns (uint32 m) {
                    capMax = m;
                } catch {}
                if (capMax > 0) {
                    try ICampaignsUserCapView(address(campaigns)).userCapWindowBlocks(claim.campaignId) returns (uint32 w) {
                        capWin = w;
                    } catch {}
                    if (capWin > 0) {
                        uint256 wid = block.number / uint256(capWin);
                        uint256 cur = userCampaignWindowEvents[user][claim.campaignId][claim.actionType][wid];
                        if (cur + claim.eventCount > uint256(capMax)) {
                            result.rejectedCount++;
                            emit ClaimRejected(claim.campaignId, user, claim.nonce, 29);
                            gapFound = true;
                            continue;
                        }
                        userCampaignWindowEvents[user][claim.campaignId][claim.actionType][wid] = cur + claim.eventCount;
                    }
                }
            }

            // BM-5: Per-publisher window rate limit (view claims only).
            //       Delegated to DatumSettlementRateLimiter (atomic try-consume).
            if (address(rateLimiter) != address(0) && claim.actionType == 0) {
                if (!rateLimiter.tryConsume(claim.publisher, claim.eventCount)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 14);
                    gapFound = true;
                    continue;
                }
            }

            // FP-1: Publisher stake adequacy check (optional)
            if (address(publisherStake) != address(0)) {
                if (!publisherStake.isAdequatelyStaked(claim.publisher)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 15);
                    gapFound = true;
                    continue;
                }
            }

            // FP-5: Nullifier replay check + register (atomic; view claims only).
            //       Delegated to DatumNullifierRegistry.tryConsume which marks
            //       the nullifier used and returns false on replay collision.
            //       Equivalent to the previous split check/register pattern --
            //       only the CEI hashChain update sat between, which cannot
            //       fail (mapping writes).
            if (
                address(nullifiers) != address(0) &&
                claim.actionType == 0 &&
                claim.nullifier != bytes32(0)
            ) {
                if (!nullifiers.tryConsume(claim.campaignId, claim.nullifier)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            lastClaimHash[user][claim.campaignId][claim.actionType] = computedHash;
            lastNonce[user][claim.campaignId][claim.actionType] = claim.nonce;

            // CPC: mark click session as claimed (type-1 only)
            if (claim.actionType == 1 && address(clickRegistry) != address(0) && claim.clickSessionHash != bytes32(0)) {
                clickRegistry.markClaimed(user, claim.campaignId, claim.clickSessionHash);
            }

            // Compute payment
            uint256 totalPayment;
            if (claim.actionType == 0) {
                // CPM: rate per 1000 events
                totalPayment = (claim.ratePlanck * claim.eventCount) / 1000;
            } else {
                // CPC / CPA: flat rate per event
                totalPayment = claim.ratePlanck * claim.eventCount;
            }

            uint256 publisherPayment = (totalPayment * cTakeRate) / BPS_DENOMINATOR;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * uint256(userShareBps)) / BPS_DENOMINATOR;
            uint256 protocolFee = rem - userPayment;

            // Deduct from budget ledger and transfer DOT to payment vault
            bool exhausted = budgetLedger.deductAndTransfer(
                claim.campaignId, claim.actionType, totalPayment, address(paymentVault)
            );
            if (exhausted) {
                agg.exhausted = true;
                agg.campaignIdExhausted = campaignId;
                gapFound = true;
            }

            agg.total += totalPayment;
            agg.publisherPayment += publisherPayment;
            agg.userPayment += userPayment;
            agg.protocolFee += protocolFee;
            if (agg.publisher == address(0)) agg.publisher = claim.publisher;

            // Token reward (view claims only)
            if (claim.actionType == 0 && agg.rewardToken != address(0) && agg.rewardPerImpression > 0) {
                agg.tokenReward += claim.eventCount * agg.rewardPerImpression;
            }

            // Track events for publisher stake bonding curve
            agg.eventsSettled += claim.eventCount;

            // #5: PoW leaky-bucket update — engine call moved out of the
            //     inner loop; happens once per batch after the loop with the
            //     accumulated `agg.eventsSettled`. Equivalent semantics
            //     because successive claims in the same batch share
            //     lastUpdate == block.number, so only the first claim's
            //     drain term ever fires.

            // #2-extension: cumulative settled events across all campaigns.
            //               Drives per-campaign minUserSettledHistory gate.
            userTotalSettled[user] += claim.eventCount;

            result.settledCount++;
            result.totalPaid += totalPayment;

            emit ClaimSettled(
                claim.campaignId,
                user,
                claim.publisher,
                claim.eventCount,
                claim.ratePlanck,
                claim.actionType,
                claim.nonce,
                publisherPayment,
                userPayment,
                protocolFee
            );
        }

        // #5: PoW leaky-bucket update — one engine call per batch.
        //     `agg.eventsSettled` aggregates eventCount across all settled
        //     claims in this batch; replaces the per-claim inline update.
        if (address(powEngine) != address(0) && agg.eventsSettled > 0) {
            powEngine.consumeFor(user, agg.eventsSettled);
        }

        // L-7: Global per-block circuit breaker
        if (agg.total > 0 && maxSettlementPerBlock > 0) {
            if (_cbBlock != block.number) {
                _cbBlock = block.number;
                _cbTotal = 0;
            }
            _cbTotal += agg.total;
            if (!(_cbTotal <= maxSettlementPerBlock)) revert E80();
        }

        // Aggregate paymentVault credit
        if (agg.total > 0) {
            paymentVault.creditSettlement(
                agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee
            );
        }

        // ── DATUM token mint — delegated to DatumMintCoordinator ──
        // The coordinator runs the engine-or-fallback computation, applies
        // the dust gate, splits across user/publisher/advertiser per the
        // configured bps, and delegates the actual mint to the wired
        // MintAuthority. Failures fail-soft inside the coordinator (try/
        // catch + DatumMintFailed event there) so settlement never reverts
        // on a mint-side problem.
        if (address(mintCoordinator) != address(0) && agg.total > 0) {
            address advertiser = address(campaigns) == address(0)
                ? address(0)
                : campaigns.getCampaignAdvertiser(campaignId);
            mintCoordinator.coordinate(user, agg.publisher, advertiser, agg.total);
        }

        // Aggregate token reward credit (view claims only, non-critical)
        if (agg.tokenReward > 0) {
            try tokenRewardVault.creditReward(campaignId, agg.rewardToken, user, agg.tokenReward) {}
            catch {
                // L-4: surface a failure so the credit doesn't disappear silently.
                emit RewardCreditFailed(campaignId, user, agg.rewardToken, agg.tokenReward);
            }
        }

        // FP-1: Record settled events on publisher stake bonding curve
        if (address(publisherStake) != address(0) && agg.eventsSettled > 0 && agg.publisher != address(0)) {
            publisherStake.recordImpressions(agg.publisher, agg.eventsSettled);
        }

        // CB4: Record DOT spent on advertiser stake bonding curve. Best-effort
        // (try/catch) so a misconfigured advertiser-stake target cannot DoS
        // settlement. Looked up via campaigns.getCampaignAdvertiser since
        // batches are scoped to one campaignId.
        if (advertiserStake != address(0) && agg.total > 0 && address(campaigns) != address(0)) {
            address advertiser_ = campaigns.getCampaignAdvertiser(campaignId);
            if (advertiser_ != address(0)) {
                (bool ok, ) = advertiserStake.call(abi.encodeWithSignature(
                    "recordBudgetSpent(address,uint256)",
                    advertiser_, agg.total
                ));
                ok; // suppressed: callback failure is non-critical
            }
        }

        // FP-16: Record reputation stats via the carved-out module.
        if (address(reputation) != address(0) && agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                reputation.recordSettlement(agg.publisher, campaignId, batchSettled, batchRejected);
            }
        }

        // Auto-complete campaign if budget exhausted
        if (agg.exhausted) {
            lifecycle.completeCampaign(agg.campaignIdExhausted);
        }

        // BM-10: Record block of last successful settlement
        if (interval > 0 && result.settledCount > prevSettledCount) {
            lastSettlementBlock[user][campaignId][batchActionType] = block.number;
        }
    }

    // -------------------------------------------------------------------------
    // Rate-limiter, nullifier, and reputation views all moved to their
    // respective carve-out modules.
}
