// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./DatumOwnable.sol";
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

/// @dev Minimal interface to DatumMintAuthority for the DATUM-token integration.
///      Kept inline (rather than a full interface file) because Settlement only
///      uses this single function, and the authority itself is optional —
///      zero-address mintAuthority disables the mint flow.
interface IDatumMintAuthority_Settle {
    function mintForSettlement(
        address user, uint256 userAmt,
        address publisher, uint256 publisherAmt,
        address advertiser, uint256 advertiserAmt
    ) external;
}

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
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, EIP712, DatumOwnable {
    IDatumBudgetLedger public budgetLedger;
    IDatumPaymentVault public paymentVault;
    IDatumCampaignLifecycle public lifecycle;
    address public relayContract;
    IDatumPauseRegistry public immutable pauseRegistry;
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

    // ── DATUM token integration (zero address = disabled) ────────────────
    /// @notice Mint authority for DATUM emissions. When set, every settled
    ///         claim mints WDATUM to user/publisher/advertiser proportional
    ///         to the payment, gated by `mintRatePerDot` and `dustMintThreshold`.
    /// @dev    Set once via `setMintAuthority(addr)`. Cannot be unset (would
    ///         require redeploying settlement). Zero address at deploy keeps
    ///         the contract backward-compatible with pre-token alpha-4.
    address public mintAuthority;

    /// @notice DATUM per 1 DOT settled, in 10-decimal units.
    /// @dev    This is the §3.3 `currentRate` (bootstrap value 19e10 = 19 DATUM/DOT).
    ///         For scaffold integration this is held here as a governance-tunable
    ///         value. The full Path H adaptive-rate machinery will move to a
    ///         dedicated DatumMintCurve contract in a follow-up.
    uint256 public mintRatePerDot = 19 * 10**10;

    /// @notice A3/B4-fix (2026-05-12): hard ceiling on `mintRatePerDot`. Caps the
    ///         per-settlement DATUM emission an owner can dial in via setMintRate.
    ///         100 DATUM/DOT — ~5× the bootstrap rate. MintAuthority enforces the
    ///         95M cap separately; this just prevents a hostile owner from
    ///         burning the entire mintable supply on a single large batch.
    uint256 public constant MAX_MINT_RATE = 100 * 10**10;

    /// @notice Skip the DATUM mint entirely when totalMint < threshold.
    /// @dev    Saves gas on dust mints. Default 0.01 DATUM (1e8 base units).
    uint256 public dustMintThreshold = 10**8;

    /// @notice Split BPS for user / publisher / advertiser DATUM rewards.
    ///         BAKED at deploy per §3.3.
    uint16 public constant DATUM_REWARD_USER_BPS       = 5500;
    uint16 public constant DATUM_REWARD_PUBLISHER_BPS  = 4000;
    uint16 public constant DATUM_REWARD_ADVERTISER_BPS =  500;

    event MintAuthoritySet(address indexed authority);
    event MintRateUpdated(uint256 oldRate, uint256 newRate);
    event DustMintThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event DatumMintFailed(address indexed user, address indexed publisher, address indexed advertiser, uint256 totalMint);

    // ── BM-5: Rate limiter (merged from DatumSettlementRateLimiter) ──
    uint256 public constant MIN_RL_WINDOW_SIZE = 10;
    uint256 public rlWindowBlocks;
    uint256 public rlMaxEventsPerWindow;
    /// @dev publisher => windowId => cumulative view events settled in that window
    mapping(address => mapping(uint256 => uint256)) public publisherWindowEvents;

    // ── FP-5: Nullifier registry (merged from DatumNullifierRegistry) ──
    uint256 public nullifierWindowBlocks;
    /// @dev campaignId => nullifier => used
    mapping(uint256 => mapping(bytes32 => bool)) private _nullifierUsed;

    // ── BM-8/BM-9: Publisher reputation (merged from DatumPublisherReputation) ──
    // Threat-model #4: counters are updated **only** by the inline _processBatch
    // path. The previous external `recordSettlement(reporter)` entry point was
    // removed so a single compromised reporter EOA can no longer poison every
    // publisher's reputation arbitrarily. All settlement paths flow through
    // _processBatch, so reputation tracking remains complete.
    uint256 public constant REP_MIN_SAMPLE = 10;
    uint256 public constant REP_ANOMALY_FACTOR = 2;
    mapping(address => uint256) public repTotalSettled;
    mapping(address => uint256) public repTotalRejected;
    mapping(address => mapping(uint256 => uint256)) public repCampaignSettled;
    mapping(address => mapping(uint256 => uint256)) public repCampaignRejected;
    // Safe rollout: minimum reputation score to settle (0 = disabled, in bps)
    uint16 public minReputationScore;

    // B5-fix (2026-05-12): per-user minimum acceptable AssuranceLevel. A user
    // writes their own floor (0..2) and Settlement rejects batches addressed to
    // that user when the campaign's effective AssuranceLevel is below it. This
    // extends the AssuranceLevel choice from advertiser-only to user-as-well:
    // users can refuse low-proof settlement (e.g. demand publisher cosig) on
    // their own behalf without relying on each campaign's advertiser to opt in.
    // Default 0 = accept any level (current behavior). Self-set only.
    mapping(address => uint8) public userMinAssurance;

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
    // #5 (2026-05-12): Per-impression PoW with leaky-bucket difficulty
    // -------------------------------------------------------------------------
    // Each impression (claim with eventCount=N, scaled by N) must satisfy
    // `keccak256(claimHash || powNonce) <= target(user, eventCount)`.
    //
    // Difficulty driver = a per-user **leaky bucket** of "recent abuse credits"
    // that drains linearly with time. Each settled event adds `eventCount` to
    // the bucket; the bucket drains 1 unit per `powBucketLeakPerN` blocks.
    // Sustained abuse keeps the bucket full → quadratic difficulty kicks in.
    // Stopping (or merely slowing) causes the bucket to drain and difficulty
    // to settle back to linear, eventually to baseline.
    //
    // Difficulty curve (all params governable):
    //   bucket    = max(0, userPowBucket - (blocksElapsed / powBucketLeakPerN))
    //   shift     = powBaseShift                          // absolute floor
    //             + bucket / powLinearDivisor             // gentle linear growth
    //             + (bucket / powQuadDivisor)^2           // quadratic on sustained abuse
    //   shift capped at POW_MAX_SHIFT (64 = effectively impossible).
    //   target    = (type(uint256).max >> shift) / eventCount
    //
    // Per-impression scaling: target divided by eventCount so a single claim
    // bundling 100 impressions needs ~100× the search work — bots cannot amortize.
    //
    // Defaults (base=8, linDiv=60, quadDiv=100, leakPerN=10):
    //   1 event drains every 10 blocks (~1 min @ 6s/block).
    //   Real user at 1 imp/min: bucket stays ≈ 0, shift=8 (256 hashes, instant).
    //   Heavy user at 10 imp/min for 1h: bucket ≈ 540, shift~46 (prohibitive).
    //   Same user stops for 90 min: bucket drains → back to ≈ 0.
    //
    // The lookback is implicit in the leak rate. With leakPerN=10 and a fully
    // saturated bucket, it takes `bucket × 10` blocks (~ bucket × 1 min) to fully
    // decay back to baseline. Governance can dial the lookback / forgiveness.
    //
    // Defaults off so existing tests + early testnet aren't blocked.
    bool public enforcePow;
    /// @notice Absolute floor of PoW difficulty bits — minimum shift regardless of usage.
    uint8 public powBaseShift = 8;
    /// @notice bucket / linearDivisor = extra bits (linear floor growth). Larger = slower growth.
    uint32 public powLinearDivisor = 60;
    /// @notice bucket / quadDivisor, squared = extra bits (quadratic abuse term). Larger = quadratic kicks in later.
    uint32 public powQuadDivisor = 100;
    /// @notice Blocks per 1 unit of bucket drainage. Larger = slower forgetting (more punitive memory).
    uint32 public powBucketLeakPerN = 10;
    /// @notice Hard cap on shift_bits so contract math can't run away — 64 bits
    ///         is already 2^64 ≈ 18 quintillion hashes per impression (impossible).
    uint8 public constant POW_MAX_SHIFT = 64;
    /// @notice Per-user leaky-bucket counter; drains over time, fills on settled events.
    mapping(address => uint256) public userPowBucket;
    /// @notice Block of the last bucket read/write (lazy decay).
    mapping(address => uint256) public userPowBucketLastUpdate;
    event PowEnforcementSet(bool enforced);
    event PowDifficultyCurveSet(uint8 baseShift, uint32 linearDivisor, uint32 quadDivisor, uint32 bucketLeakPerN);

    // #2-extension (2026-05-12): cumulative settled events per user, all
    // campaigns + actionTypes. Drives per-campaign minUserSettledHistory
    // filters (proof-of-on-chain-history as a soft sybil bar).
    mapping(address => uint256) public userTotalSettled;

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);
    event RateLimitsUpdated(uint256 windowBlocks, uint256 maxEventsPerWindow);
    event NullifierSubmitted(uint256 indexed campaignId, bytes32 indexed nullifier);
    event NullifierWindowBlocksUpdated(uint256 oldValue, uint256 newValue);
    event SettlementRecorded(address indexed publisher, uint256 indexed campaignId, uint256 settled, uint256 rejected);
    /// @notice L-4: Emitted when the non-critical token-reward credit reverts so off-chain
    ///         monitors can flag mis-wired or under-funded reward configs.
    event RewardCreditFailed(uint256 indexed campaignId, address indexed user, address indexed token, uint256 amount);
    /// @notice A4-fix: Emitted when publishers.isBlocked() reverts during a batch.
    ///         Advisory only — settlement continues. Monitors should re-wire / fix the
    ///         publishers ref. Not a rejection.
    event BlocklistCheckFailed(uint256 indexed campaignId, address indexed publisher);

    /// @notice H2-fix: emitted when the AssuranceLevel or legacy dual-sig
    ///         lookup on Campaigns reverts. The batch is failed CLOSED
    ///         (treated as max-enforced), but operators should see this and
    ///         repair the Campaigns wiring.
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

    // M-1: Revenue split — user gets 75% of remainder after publisher take rate
    uint256 private constant USER_SHARE_BPS = 7500;
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
    /// @dev M6: extended to bind the advertiser's relay signer at sign time,
    ///      mirroring the publisher-side A1 anti-rotation pattern. A post-sign
    ///      `setAdvertiserRelaySigner` rotation invalidates in-flight cosigs.
    bytes32 private constant CLAIM_BATCH_TYPEHASH = keccak256(
        "ClaimBatch(address user,uint256 campaignId,bytes32 claimsHash,uint256 deadlineBlock,address expectedRelaySigner,address expectedAdvertiserRelaySigner)"
    );
    uint256 private _cbBlock;
    uint256 private _cbTotal;

    constructor(address _pauseRegistry) EIP712("DatumSettlement", "1") {
        require(_pauseRegistry != address(0), "E00");
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
        require(address(budgetLedger) == address(0), "already configured");
        require(_budgetLedger != address(0), "E00");
        require(_paymentVault != address(0), "E00");
        require(_lifecycle != address(0), "E00");
        require(_relay != address(0), "E00");
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
        require(addr != address(0), "E00");
        require(address(claimValidator) == address(0), "already set");
        claimValidator = IDatumClaimValidator(addr);
    }

    /// @dev Cypherpunk lock-once: same rationale as setClaimValidator —
    ///      a swappable attestation verifier lets an owner forge dual-sig.
    function setAttestationVerifier(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(attestationVerifier == address(0), "already set");
        attestationVerifier = addr;
    }

    /// @notice BM-5: Update rate limiter window size and per-publisher event cap.
    /// @dev    A8-fix (2026-05-12): once `rlWindowBlocks` is non-zero, only the
    ///         per-publisher cap (`_maxEventsPerWindow`) may change. The window
    ///         size itself is frozen because shifting it mid-flight would either
    ///         invalidate in-flight publisher proofs (DoS) or, if the new size
    ///         divides the old, re-open a previously-used window for double-use.
    function setRateLimits(uint256 _windowBlocks, uint256 _maxEventsPerWindow) external onlyOwner {
        require(_windowBlocks >= MIN_RL_WINDOW_SIZE, "E11");
        require(_maxEventsPerWindow > 0, "E11");
        if (rlWindowBlocks != 0) {
            require(_windowBlocks == rlWindowBlocks, "windowBlocks frozen");
        }
        rlWindowBlocks = _windowBlocks;
        rlMaxEventsPerWindow = _maxEventsPerWindow;
        emit RateLimitsUpdated(_windowBlocks, _maxEventsPerWindow);
    }

    function setMinClaimInterval(uint16 interval) external onlyOwner {
        minClaimInterval = interval;
    }

    /// @dev Cypherpunk lock-once: publishers ref drives blocklist + stake gates.
    ///      A swap could silently disable those (point to a permissive contract).
    ///      address(0) is a valid initial state ("feature off"); once set non-zero
    ///      it is frozen for the life of this Settlement.
    function setPublishers(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(publishers) == address(0), "already set");
        publishers = IDatumPublishers(addr);
    }

    /// @dev D3: Cypherpunk lock-once on optional feature. tokenRewardVault holds
    ///      advertiser-deposited ERC20s; a hot-swap could redirect credit() to
    ///      a hostile vault that quietly absorbs rewards. address(0) leaves the
    ///      feature off; once set non-zero it's frozen.
    function setTokenRewardVault(address addr) external onlyOwner {
        require(address(tokenRewardVault) == address(0), "already set");
        tokenRewardVault = IDatumTokenRewardVault(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        // B8-fix: structural ref, lock-once.
        require(address(campaigns) == address(0), "already set");
        require(addr != address(0), "E00");
        campaigns = IDatumCampaigns(addr);
    }

    /// @dev Cypherpunk lock-once: stake adequacy gate. Hot-swap could neuter it.
    function setPublisherStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(publisherStake) == address(0), "already set");
        publisherStake = IDatumPublisherStake(addr);
    }

    /// @dev CB4 lock-once: advertiser-stake callback target. Hot-swap could
    ///      forge budget-spent on rivals to drive their required-stake up.
    function setAdvertiserStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(advertiserStake == address(0), "already set");
        advertiserStake = addr;
    }

    /// @notice FP-5: Update nullifier window size.
    /// @dev    A8-fix (2026-05-12): lock-once. Off-chain ZK clients bake
    ///         `windowId = block.number / nullifierWindowBlocks` into the
    ///         nullifier preimage. Changing the divisor mid-flight either DoS's
    ///         every in-flight proof or, worse, lets a previously-burned
    ///         nullifier re-map to a fresh windowId (double-spend window).
    function setNullifierWindowBlocks(uint256 _windowBlocks) external onlyOwner {
        require(_windowBlocks > 0, "E11");
        require(nullifierWindowBlocks == 0, "frozen");
        emit NullifierWindowBlocksUpdated(nullifierWindowBlocks, _windowBlocks);
        nullifierWindowBlocks = _windowBlocks;
    }

    function setMinReputationScore(uint16 score) external onlyOwner {
        minReputationScore = score;
    }

    /// @notice B5-fix + M1-fix: user sets their own minimum AssuranceLevel
    ///         floor (0..3). Self-only; no admin or counterparty can lower or raise.
    ///         0 = accept any (default).
    ///         1 = require publisher cosig (relay path or publisher's own relay).
    ///         2 = require dual-sig (publisher + advertiser EIP-712 cosig).
    ///         3 = require dual-sig AND campaign must require valid ZK proofs.
    function setUserMinAssurance(uint8 level) external {
        require(level <= 3, "E11");
        userMinAssurance[msg.sender] = level;
        emit UserMinAssuranceSet(msg.sender, level);
    }

    /// @notice CB1: self-managed publisher blocklist. Caller is the user.
    ///         Blocked publishers cannot settle claims to this user.
    function setUserBlocksPublisher(address publisher, bool blocked) external {
        require(publisher != address(0), "E00");
        userBlocksPublisher[msg.sender][publisher] = blocked;
        emit UserBlocksPublisherSet(msg.sender, publisher, blocked);
    }

    /// @notice CB1: self-managed advertiser blocklist. Caller is the user.
    function setUserBlocksAdvertiser(address advertiser, bool blocked) external {
        require(advertiser != address(0), "E00");
        userBlocksAdvertiser[msg.sender][advertiser] = blocked;
        emit UserBlocksAdvertiserSet(msg.sender, advertiser, blocked);
    }

    /// @notice CB2: user self-pause kill switch. While true, no batches settle
    ///         to this user regardless of submission path or AssuranceLevel.
    ///         Self-set; only the user.
    function setUserPaused(bool paused_) external {
        userPaused[msg.sender] = paused_;
        emit UserPausedSet(msg.sender, paused_);
    }

    // -------------------------------------------------------------------------
    // #5: PoW admin + difficulty target
    // -------------------------------------------------------------------------

    /// @notice Enable / disable per-impression PoW enforcement.
    function setEnforcePow(bool enforced) external onlyOwner {
        enforcePow = enforced;
        emit PowEnforcementSet(enforced);
    }

    /// @notice Update the PoW difficulty curve. All four params bounded to
    ///         prevent footguns: baseShift in [1, 32], divisors > 0, leak > 0.
    function setPowDifficultyCurve(uint8 baseShift, uint32 linearDivisor, uint32 quadDivisor, uint32 bucketLeakPerN) external onlyOwner {
        require(baseShift >= 1 && baseShift <= 32, "E11");
        require(linearDivisor > 0, "E11");
        require(quadDivisor > 0, "E11");
        require(bucketLeakPerN > 0, "E11");
        powBaseShift = baseShift;
        powLinearDivisor = linearDivisor;
        powQuadDivisor = quadDivisor;
        powBucketLeakPerN = bucketLeakPerN;
        emit PowDifficultyCurveSet(baseShift, linearDivisor, quadDivisor, bucketLeakPerN);
    }

    /// @dev Lazy bucket read: current effective bucket = stored - drainage since
    ///      last update. Pure view; doesn't write back.
    function _readPowBucket(address user) internal view returns (uint256) {
        uint256 stored = userPowBucket[user];
        if (stored == 0) return 0;
        uint256 lastUpdate = userPowBucketLastUpdate[user];
        if (lastUpdate == 0) return stored;
        uint256 elapsed = block.number - lastUpdate;
        uint256 drained = elapsed / uint256(powBucketLeakPerN);
        return stored > drained ? stored - drained : 0;
    }

    /// @notice Current PoW target a user must satisfy for a claim of size
    ///         `eventCount`. ClaimValidator queries this view at claim-time.
    ///         Returns `keccak256(claimHash || powNonce)` upper bound (≤).
    /// @dev    Leaky bucket: sustained abuse keeps the bucket full and shifts
    ///         into quadratic difficulty; slowing or stopping drains the bucket
    ///         and difficulty decays back to baseline. Lookback is implicit in
    ///         the leak rate. Per-impression scaling: target/eventCount so
    ///         larger batches require proportionally more search work.
    function powTargetForUser(address user, uint256 eventCount) public view returns (uint256) {
        if (!enforcePow || eventCount == 0) return type(uint256).max;
        uint256 bucket = _readPowBucket(user);

        // Quadratic with linear floor: shift = base + (bucket/linDiv) + (bucket/quadDiv)^2
        uint256 linearExtra = bucket / uint256(powLinearDivisor);
        uint256 quadInput = bucket / uint256(powQuadDivisor);
        if (quadInput > type(uint32).max) quadInput = type(uint32).max;
        uint256 quadExtra = quadInput * quadInput;

        uint256 shift = uint256(powBaseShift) + linearExtra + quadExtra;
        if (shift >= POW_MAX_SHIFT) return 0; // unreachable target → only powNonce hashing to 0 passes

        return (type(uint256).max >> shift) / eventCount;
    }

    /// @notice Effective bucket level for a user right now (lazy decay applied).
    ///         Convenience view for UIs / monitoring.
    function userPowBucketEffective(address user) external view returns (uint256) {
        return _readPowBucket(user);
    }

    function setClickRegistry(address addr) external onlyOwner {
        // A13: lock once set. Re-pointing to a fresh registry would create a
        // replay window for already-claimed click sessions. Deploy a new
        // Settlement if a registry swap is genuinely required.
        require(address(clickRegistry) == address(0), "already set");
        require(addr != address(0), "E00");
        clickRegistry = IDatumClickRegistry(addr);
    }

    /// @notice L-7: Set global per-block settlement cap in planck. 0 = disabled.
    function setMaxSettlementPerBlock(uint256 cap) external onlyOwner {
        maxSettlementPerBlock = cap;
    }

    /// @notice One-time wiring of the DATUM mint authority. Set once at activation;
    ///         cannot be cleared. Activates settlement-driven DATUM minting.
    function setMintAuthority(address _mintAuthority) external onlyOwner {
        require(_mintAuthority != address(0), "E00");
        require(mintAuthority == address(0), "already set");
        mintAuthority = _mintAuthority;
        emit MintAuthoritySet(_mintAuthority);
    }

    /// @notice Update the per-DOT DATUM mint rate. Scaffold path for §3.3 currentRate.
    /// @dev    Governance-tunable for the scaffold. The full Path H adaptive
    ///         mechanism will move this to a separate contract; for now,
    ///         changes go through the standard owner/governance route.
    function setMintRate(uint256 newRate) external onlyOwner {
        // A3/B4-fix: enforce hard ceiling. See MAX_MINT_RATE for rationale.
        require(newRate <= MAX_MINT_RATE, "above cap");
        uint256 old = mintRatePerDot;
        mintRatePerDot = newRate;
        emit MintRateUpdated(old, newRate);
    }

    function setDustMintThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold <= 1 * 10**10, "above cap");  // ≤ 1 DATUM max
        uint256 old = dustMintThreshold;
        dustMintThreshold = newThreshold;
        emit DustMintThresholdUpdated(old, newThreshold);
    }

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
        // A1: off-chain ZK clients derive `windowId = block.number / nullifierWindowBlocks`
        // to bake into the nullifier preimage. A zero `nullifierWindowBlocks` makes
        // every windowId collapse to 0, breaking replay prevention across windows.
        // Require it set whenever the verifier is wired (claimValidator implies ZK path).
        if (nullifierWindowBlocks == 0) return (false, "nullifierWindowBlocks");
        // Optional references (address(0) = disabled feature, not misconfigured):
        // publishers, tokenRewardVault, publisherStake, clickRegistry, attestationVerifier
        // Inline features (rate limiter, reputation) have no external refs
        return (true, "");
    }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(address(claimValidator) != address(0), "E00");

        require(!pauseRegistry.pausedSettlement(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            bool isPublisherRelay = _isPublisherRelay(batch.claims);

            require(
                msg.sender == batch.user || msg.sender == relayContract ||
                msg.sender == attestationVerifier || isPublisherRelay,
                "E32"
            );
            _processBatch(batch.user, batch.campaignId, batch.claims, result, false);
        }
    }

    /// @inheritdoc IDatumSettlement
    function settleClaimsMulti(UserClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(address(claimValidator) != address(0), "E00");

        require(!pauseRegistry.pausedSettlement(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 u = 0; u < batches.length; u++) {
            UserClaimBatch calldata ub = batches[u];
            require(ub.campaigns.length <= 10, "E28");

            for (uint256 c = 0; c < ub.campaigns.length; c++) {
                CampaignClaims calldata cc = ub.campaigns[c];

                bool isPublisherRelay = _isPublisherRelay(cc.claims);

                require(
                    msg.sender == ub.user || msg.sender == relayContract ||
                    msg.sender == attestationVerifier || isPublisherRelay,
                    "E32"
                );

                _processBatch(ub.user, cc.campaignId, cc.claims, result, false);
            }
        }
    }

    /// @inheritdoc IDatumSettlement
    function settleSignedClaims(SignedClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(address(claimValidator) != address(0), "E00");
        require(!pauseRegistry.pausedSettlement(), "P");
        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            SignedClaimBatch calldata batch = batches[b];

            // I-3: reject empty batches — sigs over no claims do nothing and just burn gas
            require(batch.claims.length > 0, "E28");

            // A9: block.number deadline (was block.timestamp). Matches DatumRelay
            // so off-chain clients use one consistent unit across paths.
            require(block.number <= batch.deadlineBlock, "E81");

            // Build the EIP-712 struct hash over the batch envelope.
            // A1/M6: both `expectedRelaySigner` (publisher's hot key at sign
            //     time) and `expectedAdvertiserRelaySigner` (advertiser's hot
            //     key at sign time) are bound to the envelope so a post-sign
            //     rotation on either side invalidates in-flight cosigs.
            bytes32 claimsHash = _hashClaims(batch.claims);
            bytes32 structHash = keccak256(abi.encode(
                CLAIM_BATCH_TYPEHASH,
                batch.user,
                batch.campaignId,
                claimsHash,
                batch.deadlineBlock,
                batch.expectedRelaySigner,
                batch.expectedAdvertiserRelaySigner
            ));
            bytes32 digest = _hashTypedDataV4(structHash);

            // Recover and verify publisher signature
            address pubSigner = ECDSA.recover(digest, batch.publisherSig);
            address expectedPublisher = _batchPublisher(batch.claims);
            require(expectedPublisher != address(0), "E00");
            // M-3 (SM-1): every claim must target the same publisher as claims[0]
            // so the dual-sig path's authorization model matches DatumRelay.
            for (uint256 i = 1; i < batch.claims.length; i++) {
                require(batch.claims[i].publisher == expectedPublisher, "E34");
            }
            // A1: publisher sig must come from `expectedRelaySigner` (if set in
            // the envelope) OR from the publisher's EOA itself. If the envelope
            // declares a specific relay key (non-zero) it must also be the
            // currently-configured one — otherwise the publisher rotated keys
            // between sign and submit and the cosig is stale.
            if (batch.expectedRelaySigner != address(0)) {
                if (address(publishers) != address(0)) {
                    address currentRelay = address(0);
                    try publishers.relaySigner(expectedPublisher) returns (address r) {
                        currentRelay = r;
                    } catch {}
                    require(currentRelay == batch.expectedRelaySigner, "E84");
                }
                require(pubSigner == batch.expectedRelaySigner, "E82");
            } else {
                // Strict path: only the publisher's EOA can sign.
                require(pubSigner == expectedPublisher, "E82");
            }

            // Recover and verify advertiser signature.
            // M6: advertiser-side delegation mirrors the publisher-side A1 pattern.
            //   - If `expectedAdvertiserRelaySigner` is non-zero in the envelope,
            //     the sig must come from that hot key AND the advertiser must still
            //     have that key registered at submission time (a rotation between
            //     sign and submit invalidates the cosig — same anti-staleness
            //     semantics as the publisher relay path).
            //   - If zero, strict path: sig must come from the advertiser's EOA.
            address advSigner = ECDSA.recover(digest, batch.advertiserSig);
            address expectedAdvertiser = campaigns.getCampaignAdvertiser(batch.campaignId);
            require(expectedAdvertiser != address(0), "E00");
            if (batch.expectedAdvertiserRelaySigner != address(0)) {
                address currentAdvRelay = address(0);
                try campaigns.getAdvertiserRelaySigner(expectedAdvertiser) returns (address r) {
                    currentAdvRelay = r;
                } catch {}
                require(currentAdvRelay == batch.expectedAdvertiserRelaySigner, "E85");
                require(advSigner == batch.expectedAdvertiserRelaySigner, "E83");
            } else {
                // Strict path: only the advertiser's EOA can sign.
                require(advSigner == expectedAdvertiser, "E83");
            }

            _processBatch(batch.user, batch.campaignId, batch.claims, result, true);
        }
    }

    /// @dev Compute a deterministic hash over all claims in a batch for EIP-712 signing.
    ///      Each claim is hashed individually, then all hashes are combined.
    function _hashClaims(Claim[] calldata claims) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](claims.length);
        for (uint256 i = 0; i < claims.length; i++) {
            hashes[i] = claims[i].claimHash;
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @dev Extract the publisher address from the first claim in a batch.
    function _batchPublisher(Claim[] calldata claims) internal pure returns (address) {
        if (claims.length == 0) return address(0);
        return claims[0].publisher;
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
        require(claims.length <= 10, "E28");

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
        // happens per-claim below since the publisher can vary per claim in
        // legacy relay paths.
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

            // Legacy fallback: older deployments may still set requiresDualSig
            // directly without touching the new assurance field. getCampaignAssuranceLevel
            // already OR-merges them, so this is redundant once that lands —
            // kept here as a safety net during migration.
            // H2-fix (2026-05-13): on revert, fail-OPEN here specifically because
            // the AssuranceLevel reader above (which OR-merges this flag) already
            // succeeded. Fail-closing on a redundant check would over-reject L0
            // campaigns whose legacy getter selector mismatches. Audit event
            // surfaces the lookup failure for operators.
            try campaigns.getCampaignRequiresDualSig(campaignId) returns (bool needsDual) {
                if (needsDual) {
                    for (uint256 j = 0; j < claims.length; j++) {
                        result.rejectedCount++;
                        emit ClaimRejected(campaignId, user, claims[j].nonce, 24);
                    }
                    return;
                }
            } catch {
                emit AssuranceLookupFailed(campaignId);
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

        // Safe rollout: reputation gate (inline — merged from DatumPublisherReputation)
        uint16 minRepScore = minReputationScore;
        if (minRepScore > 0 && claims.length > 0) {
            uint16 score = _getReputationScore(claims[0].publisher);
            if (score < minRepScore) {
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
            // at L1+. At L0 the protocol prefers liveness (a single rev'd
            // publishers ref shouldn't DoS the whole flow); at L1+ the
            // advertiser has signed something stronger and expects blocklist
            // to be enforced, so a revert must reject rather than slip past.
            if (address(publishers) != address(0)) {
                try publishers.isBlocked(claim.publisher) returns (bool blocked) {
                    if (blocked) {
                        result.rejectedCount++;
                        emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                } catch {
                    if (effectiveLevel >= 1) {
                        // Fail closed: blocklist gate is part of L1+ guarantees.
                        result.rejectedCount++;
                        emit BlocklistFailedClosed(claim.campaignId, claim.publisher);
                        emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                    // L0: advisory event, continue settlement.
                    emit BlocklistCheckFailed(claim.campaignId, claim.publisher);
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

            // BM-5: Per-publisher window rate limit (inline; view claims only)
            if (rlWindowBlocks > 0 && claim.actionType == 0) {
                uint256 windowId = block.number / rlWindowBlocks;
                uint256 current = publisherWindowEvents[claim.publisher][windowId];
                if (current + claim.eventCount > rlMaxEventsPerWindow) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 14);
                    gapFound = true;
                    continue;
                }
                publisherWindowEvents[claim.publisher][windowId] = current + claim.eventCount;
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

            // FP-5: Nullifier replay check (view claims only, inline)
            if (claim.actionType == 0 && claim.nullifier != bytes32(0)) {
                if (_nullifierUsed[claim.campaignId][claim.nullifier]) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            lastClaimHash[user][claim.campaignId][claim.actionType] = computedHash;
            lastNonce[user][claim.campaignId][claim.actionType] = claim.nonce;

            // FP-5: Register nullifier (view claims only, inline)
            if (claim.actionType == 0 && claim.nullifier != bytes32(0)) {
                require(!_nullifierUsed[claim.campaignId][claim.nullifier], "E73");
                _nullifierUsed[claim.campaignId][claim.nullifier] = true;
                emit NullifierSubmitted(claim.campaignId, claim.nullifier);
            }

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
            uint256 userPayment = (rem * USER_SHARE_BPS) / BPS_DENOMINATOR;
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

            // #5: Leaky-bucket update — drains by elapsed-blocks-since-last-update,
            //     then adds the new events. Drives difficulty for *next* claim.
            //     Sustained abuse keeps bucket full → quadratic difficulty;
            //     slowing/stopping drains the bucket → linear decay back to baseline.
            {
                uint256 stored = userPowBucket[user];
                uint256 lastUpdate = userPowBucketLastUpdate[user];
                uint256 drained;
                if (lastUpdate != 0) {
                    drained = (block.number - lastUpdate) / uint256(powBucketLeakPerN);
                }
                uint256 afterDrain = stored > drained ? stored - drained : 0;
                userPowBucket[user] = afterDrain + claim.eventCount;
                userPowBucketLastUpdate[user] = block.number;
            }

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

        // L-7: Global per-block circuit breaker
        if (agg.total > 0 && maxSettlementPerBlock > 0) {
            if (_cbBlock != block.number) {
                _cbBlock = block.number;
                _cbTotal = 0;
            }
            _cbTotal += agg.total;
            require(_cbTotal <= maxSettlementPerBlock, "E80");
        }

        // Aggregate paymentVault credit
        if (agg.total > 0) {
            paymentVault.creditSettlement(
                agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee
            );
        }

        // ── DATUM token mint (optional; gated on mintAuthority being set) ──
        // Per §3.3: mint = payoutDOT × currentRate, split 55/40/5 user/publisher/advertiser.
        // Skipped entirely if mintAuthority is unset (pre-token alpha-4 compatibility).
        // Skipped per-batch if total mint would be below dust threshold.
        if (mintAuthority != address(0) && agg.total > 0) {
            // mintRate stored in 10-decimal base units (e.g. 19e10 = 19 DATUM/DOT).
            // Both DOT planck and DATUM base units use 10 decimals; divide by 1e10 once.
            uint256 totalMint = (agg.total * mintRatePerDot) / (10**10);
            if (totalMint >= dustMintThreshold) {
                uint256 userMint        = (totalMint * DATUM_REWARD_USER_BPS)      / 10000;
                uint256 publisherMint   = (totalMint * DATUM_REWARD_PUBLISHER_BPS) / 10000;
                uint256 advertiserMint  = totalMint - userMint - publisherMint;  // 500 bps + remainder
                address advertiser = address(campaigns) == address(0)
                    ? address(0)
                    : campaigns.getCampaignAdvertiser(campaignId);

                // Authority enforces its own MINTABLE_CAP; we don't second-guess here.
                try IDatumMintAuthority_Settle(mintAuthority).mintForSettlement(
                    user,        userMint,
                    agg.publisher, publisherMint,
                    advertiser,  advertiserMint
                ) {} catch {
                    // Non-critical: if the mint authority rejects (cap hit, etc.)
                    // we don't want settlement to revert. Emit a signal for observers.
                    emit DatumMintFailed(user, agg.publisher, advertiser, totalMint);
                }
            }
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

        // FP-16: Record reputation stats (inline)
        if (agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                repTotalSettled[agg.publisher] += batchSettled;
                repTotalRejected[agg.publisher] += batchRejected;
                repCampaignSettled[agg.publisher][campaignId] += batchSettled;
                repCampaignRejected[agg.publisher][campaignId] += batchRejected;
                emit SettlementRecorded(agg.publisher, campaignId, batchSettled, batchRejected);
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
    // Views: Rate limiter
    // -------------------------------------------------------------------------

    /// @notice Returns current rate-limit window usage for a publisher.
    function currentWindowUsage(address publisher)
        external
        view
        returns (uint256 windowId, uint256 events, uint256 limit)
    {
        if (rlWindowBlocks == 0) return (0, 0, 0);
        windowId = block.number / rlWindowBlocks;
        events = publisherWindowEvents[publisher][windowId];
        limit = rlMaxEventsPerWindow;
    }

    // -------------------------------------------------------------------------
    // Views: Nullifier registry
    // -------------------------------------------------------------------------

    /// @notice Returns true if the nullifier has already been submitted for this campaign.
    function isNullifierUsed(uint256 campaignId, bytes32 nullifier) external view returns (bool) {
        return _nullifierUsed[campaignId][nullifier];
    }

    // -------------------------------------------------------------------------
    // Views: Publisher reputation
    // -------------------------------------------------------------------------

    /// @notice Returns the publisher's global acceptance score in bps (0–10000).
    ///         Returns 10000 (perfect) if no data yet.
    function getReputationScore(address publisher) external view returns (uint16) {
        return _getReputationScore(publisher);
    }

    /// @notice BM-9: Returns true if the publisher's per-campaign rejection rate exceeds
    ///         2× their global rejection rate with a minimum sample of 10 claims.
    function isAnomaly(address publisher, uint256 campaignId) external view returns (bool) {
        uint256 cs = repCampaignSettled[publisher][campaignId];
        uint256 cr = repCampaignRejected[publisher][campaignId];
        uint256 cTotal = cs + cr;
        if (cTotal < REP_MIN_SAMPLE) return false;

        uint256 gs = repTotalSettled[publisher];
        uint256 gr = repTotalRejected[publisher];

        if (gr == 0) return cr > 0;
        return cr * (gs + gr) > REP_ANOMALY_FACTOR * gr * cTotal;
    }

    /// @notice Global reputation stats for a publisher.
    function getPublisherStats(address publisher)
        external
        view
        returns (uint256 settled, uint256 rejected, uint16 score)
    {
        settled = repTotalSettled[publisher];
        rejected = repTotalRejected[publisher];
        uint256 total = settled + rejected;
        score = total == 0 ? 10000 : uint16((settled * 10000) / total);
    }

    /// @notice Per-campaign reputation stats for a publisher.
    function getCampaignRepStats(address publisher, uint256 campaignId)
        external
        view
        returns (uint256 settled, uint256 rejected)
    {
        settled = repCampaignSettled[publisher][campaignId];
        rejected = repCampaignRejected[publisher][campaignId];
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _getReputationScore(address publisher) internal view returns (uint16) {
        uint256 s = repTotalSettled[publisher];
        uint256 r = repTotalRejected[publisher];
        uint256 total = s + r;
        if (total == 0) return 10000;
        return uint16((s * 10000) / total);
    }
}
