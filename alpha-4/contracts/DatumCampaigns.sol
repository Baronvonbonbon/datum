// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumChallengeBonds.sol";
import "./interfaces/IDatumActivationBonds.sol";
import "./interfaces/IDatumTagCurator.sol";
import "./interfaces/IDatumTagRegistry.sol";
import "./interfaces/IDatumAdvertiserStake.sol";

/// @title DatumCampaigns (Core)
/// @notice Campaign state management — creation, activation, pausing, views.
///         Includes inlined campaign validation (SE-3) and tag-based
///         targeting (TX-1). Creative storage (IPFS + Bulletin Chain) and
///         community reporting have been carved out into their own modules
///         for mainnet EIP-170.
///
///         Multi-pricing: campaigns hold one or more action pots (view/click/
///         remote-action). Each pot has its own budget, daily cap, and rate, escrowed
///         in DatumBudgetLedger per (campaignId, actionType).
contract DatumCampaigns is IDatumCampaigns, DatumUpgradable, PaseoSafeSender {
    // ── Custom errors (mainnet-size: replaces require strings) ──
    error E00();
    error E01();
    error E11();
    error E12();
    error E15();
    error E18();
    error E19();
    error E20();
    error E21();
    error E22();
    error E23();
    error E25();
    error E27();
    error E62();
    error E64();
    error E65();
    error E66();
    error E67();
    error E68();
    error E71();
    error E80();
    error E81();
    error E82();
    error E83();
    error E84();
    error E88();
    error E93();
    error AboveCap();
    error AlreadySet();
    error CuratorLocked();
    error LaneLocked();
    error NotRegistered();
    error Paused();
    error RegistryUnset();
    error StakeInadequate();

    function version() public pure override returns (uint256) { return 1; }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /// @dev AUDIT-022: Minimum campaign budget to prevent dust campaigns (100 mDOT = 10^9 planck).
    uint256 public constant MINIMUM_BUDGET_PLANCK = 10**9;

    /// @notice Take rate snapshotted into open campaigns (publisher = address(0))
    ///         where there is no individual publisher rate. Governable within
    ///         the same 30%–80% range as individual publishers via setDefaultTakeRateBps.
    uint16 public defaultTakeRateBps = 5000;
    /// @dev Bounds match the per-publisher take rate range enforced by DatumPublishers
    ///      so the default can never escape the protocol's stated economics.
    uint16 public constant MIN_DEFAULT_TAKE_RATE_BPS = 3000;
    uint16 public constant MAX_DEFAULT_TAKE_RATE_BPS = 8000;
    // Cap ceilings — governance-settable working values below. Original
    // alpha-3 caps (32/8) were PVM-sized; EVM permits more headroom.
    uint16 public constant MAX_PUBLISHER_TAGS_CEILING = 256;
    uint16 public constant MAX_CAMPAIGN_TAGS_CEILING  = 64;
    uint16 public maxPublisherTags = 64; // was hard-coded 32
    uint16 public maxCampaignTags  = 16; // was hard-coded 8
    event MaxPublisherTagsSet(uint16 value);
    event MaxCampaignTagsSet(uint16 value);

    // Safe rollout: max campaign budget cap (0 = disabled)
    uint256 public maxCampaignBudget;

    uint256 public immutable minimumCpmFloor;
    uint256 public immutable pendingTimeoutBlocks;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public immutable pauseRegistry;

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    address public settlementContract;
    address public governanceContract;
    address public lifecycleContract;
    IDatumPublishers public publishers;
    IDatumBudgetLedger public budgetLedger;

    // A5/B8-fix (2026-05-12): two-step accept handoff for governance-critical refs.
    // Pattern mirrors GovernanceRouter.setGovernor (A10). Once `bootstrapped` is
    // locked via lockBootstrap(), direct one-step setters revert — the only path
    // becomes stage (setX) + finalize (acceptX from the new address's context).
    // This blocks typo'd / fake-target takeovers post-deployment while keeping
    // the deploy script's one-shot wiring path workable.
    address public pendingSettlementContract;
    address public pendingGovernanceContract;
    address public pendingLifecycleContract;
    address public pendingBudgetLedger;
    /// @notice One-way switch: when true, direct setters revert; only the
    ///         stage+accept handoff path is permitted. Owner flips after the
    ///         initial wiring is verified.
    bool public bootstrapped;
    event BootstrapLocked();
    event PendingRefStaged(string indexed name, address indexed pending);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    uint256 public nextCampaignId;

    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => bytes32[]) private _campaignTags;
    mapping(uint256 => bytes32[]) private _campaignPublisherTags;

    // Action pots — set at creation, immutable per campaign
    mapping(uint256 => ActionPotConfig[]) private _campaignPots;

    // FP-2: optional challenge bonds contract (address(0) = disabled)
    IDatumChallengeBonds public challengeBonds;

    // Optimistic activation: when wired, createCampaign locks an activation
    // bond and the campaign can be activated permissionlessly after timelock
    // unless challenged. address(0) = disabled (legacy governance-vote path).
    address public activationBonds;

    // ---- Targeting registry state (merged from DatumTargetingRegistry) ----
    mapping(address => bytes32[]) private _publisherTags;
    mapping(address => mapping(bytes32 => bool)) private _publisherTagSet;
    // A8: when a publisher drops a tag, it stays effective for active campaigns
    // until `block.number >= tagRemovalEffectiveBlock`. Prevents an advertiser-
    // unfriendly griefing pattern where a publisher pulls a tag mid-campaign to
    // strand the budget. Re-adding the tag clears the pending removal.
    uint256 public constant TAG_REMOVAL_GRACE_BLOCKS = 14400; // ~24h at 6s/block
    mapping(address => mapping(bytes32 => uint256)) public tagRemovalEffectiveBlock;
    event TagRemovalScheduled(address indexed publisher, bytes32 indexed tag, uint256 effectiveBlock);

    // Approved tag registry
    bool public enforceTagRegistry;
    mapping(bytes32 => bool) public approvedTags;
    bytes32[] private _approvedTagList;
    mapping(bytes32 => uint256) private _approvedTagIndex; // 1-based

    /// @notice M5-fix: external tag curator. When set and enforceTagRegistry
    ///         is enabled, a tag is approved if EITHER the local mapping or
    ///         the curator returns true. Lock-once so a hostile owner can't
    ///         swap to a permissive curator.
    address public tagCurator;
    bool public tagCuratorLocked;
    event TagCuratorSet(address indexed curator);
    event TagCuratorLocked();

    /// @notice One-way lane lock. Once set:
    ///         - `setEnforceTagRegistry(false)` is permanently disabled (the
    ///           Curated lane stays selectable forever).
    ///         - Direct local approvedTags mutations (approveTag,
    ///           removeApprovedTag, approveTags) revert — tag curation routes
    ///           exclusively through `tagCurator` thereafter.
    ///         - The `tagRegistry` pointer cannot be unset (the StakeGated
    ///           lane stays selectable forever).
    ///
    ///         Crucially, this lock does NOT freeze protocol *parameters* —
    ///         `setMaxCampaignBudget`, `setDefaultTakeRateBps`,
    ///         `setBulletinRenewerReward`, `setMaxAllowedMinStake` remain
    ///         gov-tunable indefinitely. Lock the lane menu; free the params.
    bool public lanesLocked;
    event LanesLocked();

    /// @notice Stake-gated tag namespace. When wired, publishers/campaigns in
    ///         StakeGated mode require the tag to be bonded in this registry.
    ///         Lock-once via `lockLanes()` so a hostile owner can't swap to a
    ///         permissive registry post-launch.
    IDatumTagRegistry public tagRegistry;
    event TagRegistrySet(address indexed registry);

    /// @notice Per-campaign tag-policy lane selected by the advertiser.
    ///         0 = Any (default; requiredTags accepted as-is, matching relies
    ///             on publisher's own tag set)
    ///         1 = StakeGated (every requiredTag must be Bonded in tagRegistry)
    ///         2 = Curated    (every requiredTag must be `_isTagApproved`)
    ///         Set via `setCampaignTagMode` before activation; tightening only
    ///         (Any → StakeGated/Curated, never back).
    mapping(uint256 => uint8) public campaignTagMode;
    event CampaignTagModeSet(uint256 indexed campaignId, uint8 mode);

    /// @notice M6-fix: per-advertiser hot-key delegation. Mirrors the publisher
    ///         relay-signer pattern (DatumPublishers.relaySigner). When set,
    ///         the advertiser may cosign L2 batches from this hot key instead
    ///         of their cold EOA. The cold key always remains able to sign
    ///         directly (strict path) and to rotate this mapping.
    mapping(address => address) public advertiserRelaySigner;
    event AdvertiserRelaySignerSet(address indexed advertiser, address indexed signer);

    /// @notice CB4: optional gate on createCampaign. When set non-zero,
    ///         advertisers must be adequately staked per the bonding curve.
    ///         Lock-once for cypherpunk hardening — a hostile owner can't
    ///         swap to a permissive stake contract that always returns true.
    IDatumAdvertiserStake public advertiserStake;
    event AdvertiserStakeSet(address indexed stakeContract);

    // ---- Allowlist snapshots (merged from DatumCampaignValidator) ----
    // Per-PUBLISHER's advertiser allowlist (set by the publisher on their inventory).
    mapping(uint256 => bool) public campaignAllowlistEnabled;
    mapping(uint256 => mapping(address => bool)) public campaignAllowlistSnapshot;

    // ── Multi-publisher campaign support ───────────────────────────────────
    //
    // A campaign is either:
    //   - OPEN: campaignAllowedPublisherCount[id] == 0
    //           Any registered publisher whose tags cover the campaign's
    //           requiredTags may serve. Take rate falls back to
    //           defaultTakeRateBps (snapshotted into Campaign.snapshotTakeRateBps
    //           at creation).
    //   - ALLOWLIST: campaignAllowedPublisherCount[id] > 0
    //           Only listed publishers may serve. Per-publisher take rate is
    //           snapshotted at allowlist-add time so a publisher cannot raise
    //           their rate mid-campaign and change the deal.
    //
    // The legacy "closed campaign" (single publisher) is the degenerate
    // allowlist case with count == 1. createCampaign(publisher != 0)
    // populates the allowlist with that one publisher.
    //
    // The Campaign struct's `publisher` field remains as initialization
    // metadata (the publisher passed at creation). For multi-publisher
    // campaigns it may be stale after `removeAllowedPublisher`.
    mapping(uint256 => mapping(address => bool)) public campaignAllowedPublisher;
    mapping(uint256 => uint16) public campaignAllowedPublisherCount;
    mapping(uint256 => mapping(address => uint16)) public campaignPublisherTakeRate;

    /// @notice Cap on the number of distinct publishers per campaign. Bounds
    ///         gas on enumeration paths (DatumChallengeBonds.returnBond). MUST
    ///         remain ≤ DatumChallengeBonds.maxBondedPublishers — governance
    ///         updates both in the same proposal to keep them aligned.
    uint16 public constant MAX_ALLOWED_PUBLISHERS_CEILING = 256;
    uint16 public maxAllowedPublishers = 64; // was hard-coded 32
    event MaxAllowedPublishersSet(uint16 value);

    event PublisherAllowed(uint256 indexed campaignId, address indexed publisher, uint16 takeRateBps);
    event PublisherRemoved(uint256 indexed campaignId, address indexed publisher);

    // A3: AssuranceLevel per campaign. 0=Permissive, 1=PublisherSigned, 2=DualSigned.
    mapping(uint256 => uint8) public campaignAssuranceLevel;

    // Path A (ZK): per-campaign DATUM stake minimum a user must prove to claim.
    //              0 = disabled (any user can claim if `requiresZkProof` is set).
    //              Read by ClaimValidator and passed as pub4 to DatumZKVerifier.verifyA.
    //              Raise locks at Pending (same rules as AssuranceLevel).
    //              Bounded above by `maxAllowedMinStake` (governance-set) to prevent
    //              hostile advertisers from setting absurd values that strand users.
    mapping(uint256 => uint256) public campaignMinStake;
    event CampaignMinStakeSet(uint256 indexed campaignId, uint256 minStake);

    /// @notice Governance-set upper bound on `campaignMinStake`. 0 = no cap
    ///         (any value allowed). Owner-tunable; subject to `lanesLocked`.
    uint256 public maxAllowedMinStake;
    event MaxAllowedMinStakeSet(uint256 amount);

    // Path A (ZK): per-campaign required interest category id. bytes32(0) = any.
    //              Passed as pub6 to DatumZKVerifier.verifyA — the user proves
    //              this category is in their published interest tree (Merkle
    //              inclusion) without revealing the rest of the set.
    //              Set/replace permitted only while Pending.
    mapping(uint256 => bytes32) public campaignRequiredCategory;
    event CampaignRequiredCategorySet(uint256 indexed campaignId, bytes32 category);

    // #1 (2026-05-12): per-user per-campaign cap. Both fields default 0 = disabled.
    // Advertiser-settable. Raising locks at Pending (matches AssuranceLevel rules
    // — can't tighten mid-flight and freeze user payouts); lowering allowed any time.
    mapping(uint256 => uint32) public userEventCapPerWindow;
    mapping(uint256 => uint32) public userCapWindowBlocks;
    event CampaignUserCapSet(uint256 indexed campaignId, uint32 maxEvents, uint32 windowBlocks);

    // #2-extension (2026-05-12): per-campaign minimum cumulative settled events
    // the user must have on-record before participating. Soft proof-of-history
    // sybil bar. 0 = disabled. Advertiser-settable; same Pending-only raise rule.
    mapping(uint256 => uint32) public minUserSettledHistory;
    event CampaignMinHistorySet(uint256 indexed campaignId, uint32 minHistory);

    // People Chain identity gate (2026-05-16): per-campaign required minimum
    // identity level the user must hold (cached in DatumPeopleChainIdentity).
    // 0 = disabled (no identity gate). 1 = Reasonable. 2 = KnownGood.
    // Advertiser-settable. Raising locked at Pending (advertiser can't
    // mid-flight invalidate users who already started participating); lowering
    // permitted any time. The check itself happens in DatumSettlement, which
    // reads campaignMinIdentityLevel(id) + identity.isVerified(user, level).
    mapping(uint256 => uint8) public campaignMinIdentityLevel;
    event CampaignMinIdentityLevelSet(uint256 indexed campaignId, uint8 level);

    // Metadata (IPFS) + bulletin creative storage moved to
    // DatumCampaignCreative (alpha-4 EIP-170 carve-out). DatumCampaigns
    // no longer tracks the per-campaign metadata hash, version, or
    // cooldown state -- the module owns 100% of creative resolution.

    // ---- Community reports moved to DatumReports (alpha-4 EIP-170 carve-out) ----

    // -------------------------------------------------------------------------
    // Bulletin Chain creative storage moved to DatumBulletinCreative
    // (alpha-4 EIP-170 carve-out). Bulletin state is orthogonal to the
    // campaign hot path -- no settlement, validation, or governance flow
    // reads bulletin data -- so the module owns 100% of the state and
    // DatumCampaigns no longer references it. Frontends call the bulletin
    // module directly for creative resolution.

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        uint256 _minimumCpmFloor,
        uint256 _pendingTimeoutBlocks,
        address _publishers,
        address _pauseRegistry
    ) {
        if (!(_publishers != address(0))) revert E00();
        if (!(_pauseRegistry != address(0))) revert E00();
        minimumCpmFloor = _minimumCpmFloor;
        pendingTimeoutBlocks = _pendingTimeoutBlocks;
        publishers = IDatumPublishers(_publishers);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        nextCampaignId = 1;
    }

    // -------------------------------------------------------------------------
    // Admin — contract reference setters (S2 zero-addr checks, S3 events)
    // -------------------------------------------------------------------------

    /// @notice A5/B8-fix: pre-bootstrap, one-step; post-bootstrap, stages a
    ///         pending address and the new contract must call
    ///         `acceptSettlementContract()` from its own context.
    function setSettlementContract(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (bootstrapped) {
            pendingSettlementContract = addr;
            emit PendingRefStaged("settlement", addr);
        } else {
            emit ContractReferenceChanged("settlement", settlementContract, addr);
            settlementContract = addr;
        }
    }
    function acceptSettlementContract() external {
        address c = pendingSettlementContract;
        if (!(c != address(0) && msg.sender == c)) revert E19();
        emit ContractReferenceChanged("settlement", settlementContract, c);
        settlementContract = c;
        pendingSettlementContract = address(0);
    }

    function setGovernanceContract(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (bootstrapped) {
            pendingGovernanceContract = addr;
            emit PendingRefStaged("governance", addr);
        } else {
            emit ContractReferenceChanged("governance", governanceContract, addr);
            governanceContract = addr;
        }
    }
    function acceptGovernanceContract() external {
        address c = pendingGovernanceContract;
        if (!(c != address(0) && msg.sender == c)) revert E19();
        emit ContractReferenceChanged("governance", governanceContract, c);
        governanceContract = c;
        pendingGovernanceContract = address(0);
    }

    function setLifecycleContract(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (bootstrapped) {
            pendingLifecycleContract = addr;
            emit PendingRefStaged("lifecycle", addr);
        } else {
            emit ContractReferenceChanged("lifecycle", lifecycleContract, addr);
            lifecycleContract = addr;
        }
    }
    function acceptLifecycleContract() external {
        address c = pendingLifecycleContract;
        if (!(c != address(0) && msg.sender == c)) revert E19();
        emit ContractReferenceChanged("lifecycle", lifecycleContract, c);
        lifecycleContract = c;
        pendingLifecycleContract = address(0);
    }

    /// @dev Cypherpunk lock-once: publishers is set in the constructor (non-zero
    ///      at deploy); this setter therefore reverts on every call —
    ///      effectively immutable. Kept in the ABI to surface the lock semantics
    ///      to indexers/tooling rather than silently dropping the symbol.
    function setPublishers(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(publishers) == address(0))) revert AlreadySet();
        emit ContractReferenceChanged("publishers", address(publishers), addr);
        publishers = IDatumPublishers(addr);
    }

    function setBudgetLedger(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (bootstrapped) {
            pendingBudgetLedger = addr;
            emit PendingRefStaged("budgetLedger", addr);
        } else {
            emit ContractReferenceChanged("budgetLedger", address(budgetLedger), addr);
            budgetLedger = IDatumBudgetLedger(addr);
        }
    }
    function acceptBudgetLedger() external {
        address c = pendingBudgetLedger;
        if (!(c != address(0) && msg.sender == c)) revert E19();
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), c);
        budgetLedger = IDatumBudgetLedger(c);
        pendingBudgetLedger = address(0);
    }

    /// @notice A5/B8-fix: one-way switch. After this, the four governance-
    ///         critical setters above can only stage pending addresses; the
    ///         new contract must call its acceptX() to finalize.
    function lockBootstrap() external onlyOwner whenOpenGovPhase {
        if (!(!bootstrapped)) revert AlreadySet();
        bootstrapped = true;
        emit BootstrapLocked();
    }

    /// @notice Set challenge bonds contract.
    /// @dev    D3 cypherpunk lock-once on first non-zero write. ChallengeBonds
    ///         holds advertiser bond DOT; a hot-swap could redirect lockBond
    ///         calls to a hostile contract. address(0) leaves the feature off
    ///         and is the initial state; once set non-zero it's frozen.
    function setChallengeBonds(address addr) external onlyOwner {
        if (!(address(challengeBonds) == address(0))) revert AlreadySet();
        emit ContractReferenceChanged("challengeBonds", address(challengeBonds), addr);
        challengeBonds = IDatumChallengeBonds(addr);
    }

    /// @notice Set activation-bonds contract (optimistic activation gateway).
    /// @dev    Cypherpunk lock-once. ActivationBonds holds creator + challenger
    ///         bond DOT and is granted authority to call activateCampaign on the
    ///         optimistic path. Hot-swap would let a hostile contract drain
    ///         pending bonds or auto-activate campaigns. address(0) leaves
    ///         optimistic activation disabled and falls back to the legacy
    ///         governance-vote path.
    function setActivationBonds(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(activationBonds == address(0))) revert AlreadySet();
        emit ContractReferenceChanged("activationBonds", activationBonds, addr);
        activationBonds = addr;
    }

    /// @notice Set the maximum campaign budget. 0 disables the cap.
    /// @notice Update the take rate applied to open campaigns (publisher = address(0)).
    /// @dev Bounded to the same 30%–80% range as individual publisher take rates so
    ///      governance can't push the default outside the protocol's stated economics.
    event DefaultTakeRateUpdated(uint16 oldBps, uint16 newBps);
    function setDefaultTakeRateBps(uint16 bps) external onlyOwner {
        if (!(bps >= MIN_DEFAULT_TAKE_RATE_BPS && bps <= MAX_DEFAULT_TAKE_RATE_BPS)) revert E11();
        emit DefaultTakeRateUpdated(defaultTakeRateBps, bps);
        defaultTakeRateBps = bps;
    }

    function setMaxCampaignBudget(uint256 amount) external onlyOwner {
        maxCampaignBudget = amount;
        emit MaxCampaignBudgetSet(amount);
    }

    /// @notice Tune the per-publisher tag-list cap. Bounded by ceiling so
    ///         setPublisherTags can't be ground to a halt by an absurd value.
    function setMaxPublisherTags(uint16 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_PUBLISHER_TAGS_CEILING)) revert E11();
        maxPublisherTags = v;
        emit MaxPublisherTagsSet(v);
    }

    /// @notice Tune the per-campaign required-tag cap.
    function setMaxCampaignTags(uint16 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_CAMPAIGN_TAGS_CEILING)) revert E11();
        maxCampaignTags = v;
        emit MaxCampaignTagsSet(v);
    }

    /// @notice Tune the per-campaign publisher-allowlist cap. Governance must
    ///         keep this ≤ DatumChallengeBonds.maxBondedPublishers (set in
    ///         the same proposal) so addAllowedPublisher with bond can't
    ///         outrun the bond-enumeration limit.
    function setMaxAllowedPublishers(uint16 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_ALLOWED_PUBLISHERS_CEILING)) revert E11();
        maxAllowedPublishers = v;
        emit MaxAllowedPublishersSet(v);
    }

    /// @notice Path A: governance cap on the advertiser-settable `campaignMinStake`.
    ///         0 = no cap. Does NOT retroactively invalidate campaigns whose
    ///         minStake was set above the new cap before this change; only future
    ///         `setCampaignMinStake` calls are bounded. Parameter — gov-tunable
    ///         indefinitely; not subject to `lockLanes`.
    function setMaxAllowedMinStake(uint256 amount) external onlyOwner {
        maxAllowedMinStake = amount;
        emit MaxAllowedMinStakeSet(amount);
    }

    /// @notice Enable or disable the Curated lane's enforcement layer. False =
    ///         curated lane lets through any tag (effectively a kill-switch
    ///         that demotes Curated-mode publishers to Any-mode for tag
    ///         registration). After `lockLanes()`, this can only be flipped
    ///         from false→true — the kill switch cannot be re-armed against
    ///         the lane.
    function setEnforceTagRegistry(bool enforced) external onlyOwner {
        if (lanesLocked) if (!(enforced)) revert LaneLocked();
        enforceTagRegistry = enforced;
        emit TagRegistryEnforced(enforced);
    }

    /// @notice Advertiser tightens the lane for their campaign before
    ///         activation. Tightening only: Any (0) → StakeGated (1) or
    ///         Curated (2); StakeGated and Curated are sibling-strict and
    ///         cannot be swapped to each other (that would require a fresh
    ///         campaign). All existing `requiredTags` are re-validated against
    ///         the new lane and must satisfy it.
    function setCampaignTagMode(uint256 campaignId, uint8 mode) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (!(c.status == CampaignStatus.Pending)) revert E64(); // pre-activation only
        if (!(mode <= 2)) revert E11();

        uint8 current = campaignTagMode[campaignId];
        // Allow Any → anything; otherwise mode must equal current (idempotent).
        if (!(current == 0 || current == mode)) revert E84(); // can only tighten from Any

        // Re-validate every requiredTag under the new lane.
        bytes32[] storage reqTags = _campaignTags[campaignId];
        bool enforce = enforceTagRegistry;
        for (uint256 i = 0; i < reqTags.length; i++) {
            _requireTagAllowedForLane(reqTags[i], mode, enforce);
        }

        campaignTagMode[campaignId] = mode;
        emit CampaignTagModeSet(campaignId, mode);
    }

    /// @notice Permanently freeze the three-lane menu (Any / StakeGated /
    ///         Curated). After this, no future governance can collapse the
    ///         menu down to a single lane. Parameters within each lane
    ///         remain gov-tunable indefinitely. See `lanesLocked` natspec.
    function lockLanes() external onlyOwner whenOpenGovPhase {
        if (!(!lanesLocked)) revert AlreadySet();
        if (!(address(tagRegistry) != address(0))) revert RegistryUnset();
        lanesLocked = true;
        emit LanesLocked();
    }

    /// @notice Wire the stake-gated tag registry. Must be set before
    ///         `lockLanes()` — the lock pins this pointer permanently.
    function setTagRegistry(address registry) external onlyOwner {
        if (!(!lanesLocked)) revert LaneLocked();
        tagRegistry = IDatumTagRegistry(registry);
        emit TagRegistrySet(registry);
    }

    /// @notice Add a tag to the approved registry.
    function approveTag(bytes32 tag) external onlyOwner {
        if (!(!lanesLocked)) revert LaneLocked();
        if (!(tag != bytes32(0))) revert E00();
        if (!(!approvedTags[tag])) revert E15();
        approvedTags[tag] = true;
        _approvedTagList.push(tag);
        _approvedTagIndex[tag] = _approvedTagList.length;
        emit TagApproved(tag);
    }

    /// @notice Remove a tag from the approved registry (swap-and-pop).
    function removeApprovedTag(bytes32 tag) external onlyOwner {
        if (!(!lanesLocked)) revert LaneLocked();
        if (!(approvedTags[tag])) revert E01();
        approvedTags[tag] = false;
        uint256 idx = _approvedTagIndex[tag] - 1;
        uint256 lastIdx = _approvedTagList.length - 1;
        if (idx != lastIdx) {
            bytes32 lastTag = _approvedTagList[lastIdx];
            _approvedTagList[idx] = lastTag;
            _approvedTagIndex[lastTag] = idx + 1;
        }
        _approvedTagList.pop();
        delete _approvedTagIndex[tag];
        emit TagRemoved(tag);
    }

    /// @notice Batch approve tags.
    function approveTags(bytes32[] calldata tags) external onlyOwner {
        if (!(!lanesLocked)) revert LaneLocked();
        for (uint256 i = 0; i < tags.length; i++) {
            if (!(tags[i] != bytes32(0))) revert E00();
            if (!approvedTags[tags[i]]) {
                approvedTags[tags[i]] = true;
                _approvedTagList.push(tags[i]);
                _approvedTagIndex[tags[i]] = _approvedTagList.length;
                emit TagApproved(tags[i]);
            }
        }
    }

    /// @notice M5-fix: wire an external tag curator. When set, `_isTagApproved`
    ///         ORs the local mapping with the curator's `isTagApproved`.
    function setTagCurator(address curator) external onlyOwner {
        if (!(!tagCuratorLocked)) revert CuratorLocked();
        tagCurator = curator;
        emit TagCuratorSet(curator);
    }

    /// @notice M5-fix: permanently freeze the tag curator pointer.
    function lockTagCurator() external onlyOwner whenOpenGovPhase {
        if (!(!tagCuratorLocked)) revert AlreadySet();
        tagCuratorLocked = true;
        emit TagCuratorLocked();
    }

    /// @notice CB4: wire the advertiser-stake contract. Lock-once: a hostile
    ///         owner cannot hot-swap to a permissive stake reader. Set to
    ///         address(0) at deploy if not yet ready; first non-zero write
    ///         is final.
    function setAdvertiserStake(address addr) external onlyOwner {
        if (!(address(advertiserStake) == address(0))) revert AlreadySet();
        if (!(addr != address(0))) revert E00();
        advertiserStake = IDatumAdvertiserStake(addr);
        emit AdvertiserStakeSet(addr);
    }

    /// @notice M5-fix: effective tag approval. Local mapping OR external curator.
    function _isTagApproved(bytes32 tag) internal view returns (bool) {
        if (approvedTags[tag]) return true;
        if (tagCurator != address(0)) {
            try IDatumTagCurator(tagCurator).isTagApproved(tag) returns (bool ok) {
                return ok;
            } catch {
                return false;
            }
        }
        return false;
    }

    /// @notice List all approved tags.
    function listApprovedTags() external view returns (bytes32[] memory) {
        return _approvedTagList;
    }

    // -------------------------------------------------------------------------
    // Campaign creation
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Publisher tag management (merged from DatumTargetingRegistry)
    // -------------------------------------------------------------------------

    /// @notice Publisher sets their supported tags (max 32). Replaces all previous tags.
    ///         A8: tags being dropped enter a grace period — they remain effective
    ///         for `hasAllTags` calls until `block.number >= effectiveBlock`. Tags
    ///         being re-added clear any pending removal.
    function setPublisherTags(bytes32[] calldata tagHashes) external whenNotFrozen {
        if (!(!pauseRegistry.pausedCampaignCreation())) revert Paused();
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(msg.sender);
        if (!(pub.registered)) revert NotRegistered();
        if (!(tagHashes.length <= maxPublisherTags)) revert E65();

        // Stage removals: for each old tag, decide whether the new set keeps it.
        // Tags being dropped enter the grace window. Tags being kept have any
        // pending removal cleared.
        bytes32[] storage oldTags = _publisherTags[msg.sender];
        for (uint256 i = 0; i < oldTags.length; i++) {
            bytes32 ot = oldTags[i];
            bool kept = false;
            for (uint256 j = 0; j < tagHashes.length; j++) {
                if (tagHashes[j] == ot) { kept = true; break; }
            }
            _publisherTagSet[msg.sender][ot] = false;
            if (kept) {
                tagRemovalEffectiveBlock[msg.sender][ot] = 0;
            } else {
                uint256 eff = block.number + TAG_REMOVAL_GRACE_BLOCKS;
                tagRemovalEffectiveBlock[msg.sender][ot] = eff;
                emit TagRemovalScheduled(msg.sender, ot, eff);
            }
        }

        delete _publisherTags[msg.sender];
        uint8 mode = publishers.publisherTagMode(msg.sender);
        bool enforce = enforceTagRegistry;
        for (uint256 i = 0; i < tagHashes.length; i++) {
            if (!(tagHashes[i] != bytes32(0))) revert E00();
            _requireTagAllowedForLane(tagHashes[i], mode, enforce);
            _publisherTags[msg.sender].push(tagHashes[i]);
            _publisherTagSet[msg.sender][tagHashes[i]] = true;
            // Re-adding a previously-pending tag aborts its removal.
            tagRemovalEffectiveBlock[msg.sender][tagHashes[i]] = 0;

            // Best-effort: refresh usage in the stake-gated registry so the
            // tag's expiry timer is bumped while it's actively in use.
            if (mode == 1 && address(tagRegistry) != address(0)) {
                // recordUsage is gated to campaignsContract; if wiring is
                // incomplete this reverts. Try/catch so a publisher's tag
                // update doesn't fail on a misconfigured ref.
                try tagRegistry.recordUsage(tagHashes[i]) {} catch {}
            }
        }

        emit TagsUpdated(msg.sender, tagHashes);
    }

    /// @notice Lane-aware tag validation. Reverts if the tag is not acceptable
    ///         under the chosen lane.
    ///         mode 0 (Any)         — no check beyond non-zero.
    ///         mode 1 (StakeGated)  — tag must be Bonded in `tagRegistry`.
    ///         mode 2 (Curated)     — tag must satisfy `_isTagApproved` when
    ///                                 `enforceTagRegistry` is true. When the
    ///                                 kill-switch is off, the lane is demoted
    ///                                 to permissive for tag acceptance.
    function _requireTagAllowedForLane(bytes32 tag, uint8 mode, bool enforce) internal view {
        if (mode == 0) return;
        if (mode == 1) {
            if (!(address(tagRegistry) != address(0))) revert RegistryUnset();
            if (!(tagRegistry.isTagBonded(tag))) revert E82(); // not bonded
            return;
        }
        if (!(mode == 2)) revert E83(); // unknown mode
        if (enforce) if (!(_isTagApproved(tag))) revert E81();
    }

    /// @notice Returns all tags for a publisher.
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    /// @notice Returns true if publisher has ALL of the required tags (AND logic).
    ///         A8: tags in their post-removal grace window still count as held.
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool) {
        if (requiredTags.length == 0) return true;
        if (!(requiredTags.length <= maxCampaignTags)) revert E66();
        for (uint256 i = 0; i < requiredTags.length; i++) {
            if (_publisherTagSet[publisher][requiredTags[i]]) continue;
            uint256 eff = tagRemovalEffectiveBlock[publisher][requiredTags[i]];
            if (eff != 0 && block.number < eff) continue; // still in grace
            return false;
        }
        return true;
    }

    // Community reports moved to DatumReports (alpha-4 EIP-170 carve-out).

    // -------------------------------------------------------------------------
    // Campaign creation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @notice Backwards-compat overload — equivalent to the 8-arg form with
    ///         activationBondAmount = 0 (legacy always-vote activation path).
    function createCampaign(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount
    ) external payable whenNotFrozen returns (uint256 campaignId) {
        return _createCampaign(publisher, pots, requiredTags, requireZkProof, rewardToken, rewardPerImpression, bondAmount, 0);
    }

    function createCampaignWithActivation(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount,
        uint256 activationBondAmount
    ) external payable whenNotFrozen returns (uint256 campaignId) {
        return _createCampaign(publisher, pots, requiredTags, requireZkProof, rewardToken, rewardPerImpression, bondAmount, activationBondAmount);
    }

    function _createCampaign(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount,
        uint256 activationBondAmount
    ) internal nonReentrant returns (uint256 campaignId) {
        if (!(!pauseRegistry.pausedCampaignCreation())) revert Paused();

        // CB4: optional advertiser-stake gate. When the stake contract is
        // wired, the caller must be adequately staked per the bonding curve.
        // Fail-closed on revert (treat unreadable stake as inadequate) so a
        // misconfigured stake ref can't bypass the gate.
        if (address(advertiserStake) != address(0)) {
            bool ok = false;
            try advertiserStake.isAdequatelyStaked(msg.sender) returns (bool s) {
                ok = s;
            } catch {
                ok = false;
            }
            if (!(ok)) revert StakeInadequate();
        }

        if (!(msg.value > bondAmount + activationBondAmount)) revert E11();
        uint256 budgetValue = msg.value - bondAmount - activationBondAmount;
        if (!(budgetValue >= MINIMUM_BUDGET_PLANCK)) revert E11();
        if (!(maxCampaignBudget == 0 || budgetValue <= maxCampaignBudget)) revert E80();
        if (!(requiredTags.length <= maxCampaignTags)) revert E66();
        // C1-fix: forbid stranded bonds. If the advertiser passes a non-zero
        // bondAmount while ChallengeBonds isn't wired, the lockBond branch
        // below is skipped and the bondAmount portion would sit in this
        // contract permanently (no withdrawal path). Fail loudly instead.
        if (!(bondAmount == 0 || address(challengeBonds) != address(0))) revert E00();
        // Same protection for activation bond: forbid stranded value if the
        // ActivationBonds gateway isn't wired.
        if (!(activationBondAmount == 0 || activationBonds != address(0))) revert E00();

        // Validate pots
        if (!(pots.length >= 1 && pots.length <= 3)) revert E93();
        {
            bool[3] memory seen;
            uint256 totalPotBudget;
            for (uint256 i = 0; i < pots.length; i++) {
                if (!(pots[i].actionType <= 2)) revert E88();
                if (!(!seen[pots[i].actionType])) revert E93();
                seen[pots[i].actionType] = true;
                if (!(pots[i].budgetPlanck > 0)) revert E11();
                if (!(pots[i].dailyCapPlanck > 0 && pots[i].dailyCapPlanck <= pots[i].budgetPlanck)) revert E12();
                if (!(pots[i].ratePlanck > 0)) revert E11();
                if (pots[i].actionType == 0) {
                    if (!(pots[i].ratePlanck >= minimumCpmFloor)) revert E27();
                }
                totalPotBudget += pots[i].budgetPlanck;
            }
            if (!(totalPotBudget == budgetValue)) revert E11();
        }

        // Inline validation (merged from CampaignValidator)
        uint16 snapshot;
        address snapRelaySigner;
        bytes32[] memory snapPubTags;
        bool allowlistWasEnabled;
        {
            // S12: reject blocked advertisers
            if (!(!publishers.isBlocked(msg.sender))) revert E62();

            if (publisher != address(0)) {
                if (!(!publishers.isBlocked(publisher))) revert E62();
                IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
                if (!(pub.registered)) revert E62();

                // S12: per-publisher allowlist
                allowlistWasEnabled = publishers.allowlistEnabled(publisher);
                if (allowlistWasEnabled) {
                    if (!(publishers.isAllowedAdvertiser(publisher, msg.sender))) revert E62();
                }

                // TX-1: tag matching
                if (requiredTags.length > 0) {
                    for (uint256 i = 0; i < requiredTags.length; i++) {
                        if (!(_publisherTagSet[publisher][requiredTags[i]])) revert E62();
                    }
                }

                snapshot = pub.takeRateBps;
                snapRelaySigner = publishers.relaySigner(publisher);
                snapPubTags = _publisherTags[publisher];
            } else {
                snapshot = defaultTakeRateBps;
            }
        }

        campaignId = nextCampaignId++;

        // AUDIT-005: Store allowlist snapshot
        if (allowlistWasEnabled) {
            campaignAllowlistEnabled[campaignId] = true;
            campaignAllowlistSnapshot[campaignId][msg.sender] = true;
        }

        // Multi-publisher: a closed campaign is just an allowlist of one.
        if (publisher != address(0)) {
            campaignAllowedPublisher[campaignId][publisher] = true;
            campaignAllowedPublisherCount[campaignId] = 1;
            campaignPublisherTakeRate[campaignId][publisher] = snapshot;
            emit PublisherAllowed(campaignId, publisher, snapshot);
        }

        if (rewardToken != address(0)) {
            if (!(rewardPerImpression > 0)) revert E11();
        }

        // Find view bid for struct
        uint256 vBid;
        for (uint256 i = 0; i < pots.length; i++) {
            if (pots[i].actionType == 0) { vBid = pots[i].ratePlanck; break; }
        }

        _campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            publisher: publisher,
            pendingExpiryBlock: block.number + pendingTimeoutBlocks,
            terminationBlock: 0,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending,
            relaySigner: snapRelaySigner,
            requiresZkProof: requireZkProof,
            rewardToken: rewardToken,
            rewardPerImpression: rewardPerImpression,
            viewBid: vBid
        });

        // Store required tags
        if (requiredTags.length > 0) {
            for (uint256 i = 0; i < requiredTags.length; i++) {
                _campaignTags[campaignId].push(requiredTags[i]);
            }
        }

        // Store publisher tag snapshots
        for (uint256 i = 0; i < snapPubTags.length; i++) {
            _campaignPublisherTags[campaignId].push(snapPubTags[i]);
        }

        // Store pots and initialize budget per pot
        for (uint256 i = 0; i < pots.length; i++) {
            _campaignPots[campaignId].push(pots[i]);
            budgetLedger.initializeBudget{value: pots[i].budgetPlanck}(
                campaignId, pots[i].actionType, pots[i].budgetPlanck, pots[i].dailyCapPlanck
            );
        }

        // FP-2: Lock optional bond in ChallengeBonds
        if (bondAmount > 0 && address(challengeBonds) != address(0)) {
            challengeBonds.lockBond{value: bondAmount}(campaignId, msg.sender, publisher);
        }

        // Optimistic activation: open the activation bond if the gateway is
        // wired and the advertiser supplied bond value. Without this, the
        // campaign sits Pending until governance activates it through the
        // legacy vote path.
        if (activationBondAmount > 0 && activationBonds != address(0)) {
            IDatumActivationBonds(activationBonds).openBond{value: activationBondAmount}(
                campaignId, msg.sender
            );
        }

        // A3: AssuranceLevel defaults to Permissive (0) for both open and
        // closed campaigns. The advertiser explicitly opts into higher levels
        // via setCampaignAssuranceLevel — no protocol-imposed paternalism.
        emit CampaignCreated(campaignId, msg.sender, publisher, budgetValue, snapshot);
    }

    // Metadata (setMetadata + getCampaignMetadata) moved to
    // DatumCampaignCreative (alpha-4 EIP-170 carve-out).

    /// @notice A3: Effective AssuranceLevel.
    function getCampaignAssuranceLevel(uint256 campaignId) public view returns (uint8) {
        return campaignAssuranceLevel[campaignId];
    }

    /// @notice A3: Set the campaign's AssuranceLevel. Raising the bar is
    ///         locked once Active (advertiser can't freeze user earnings
    ///         mid-flight by adding new sig requirements they then refuse
    ///         to provide). Lowering is permitted at any time — less proof
    ///         never invalidates past claims and gives the advertiser an
    ///         escape if their cosign pipeline breaks.
    function setCampaignAssuranceLevel(uint256 campaignId, uint8 level) external whenNotFrozen {
        if (!(level <= 2)) revert E11();
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        uint8 current = campaignAssuranceLevel[campaignId];
        if (level > current) {
            if (!(c.status == CampaignStatus.Pending)) revert E22();
        }
        campaignAssuranceLevel[campaignId] = level;
        emit CampaignAssuranceLevelSet(campaignId, level);
    }

    /// @notice Path A: set the campaign's minimum DATUM stake threshold for
    ///         ZK-gated claims. 0 disables the gate. Raising locked at Pending
    ///         (advertiser can't strand staked users mid-flight); lowering allowed
    ///         any time (loosens the gate — past claims remain valid).
    function setCampaignMinStake(uint256 campaignId, uint256 minStake) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        // Governance-set upper bound. 0 = no cap.
        if (!(maxAllowedMinStake == 0 || minStake <= maxAllowedMinStake)) revert E11();
        if (minStake > campaignMinStake[campaignId]) {
            if (!(c.status == CampaignStatus.Pending)) revert E22();
        }
        campaignMinStake[campaignId] = minStake;
        emit CampaignMinStakeSet(campaignId, minStake);
    }

    /// @notice Path A: set the campaign's required interest category.
    ///         bytes32(0) = any. Changes locked once Active (changing a required
    ///         category mid-flight would invalidate user proofs in flight).
    function setCampaignRequiredCategory(uint256 campaignId, bytes32 category) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (!(c.status == CampaignStatus.Pending)) revert E22();
        campaignRequiredCategory[campaignId] = category;
        emit CampaignRequiredCategorySet(campaignId, category);
    }

    /// @notice Path A getter — convenience accessor for ClaimValidator.
    function getCampaignMinStake(uint256 campaignId) external view returns (uint256) {
        return campaignMinStake[campaignId];
    }

    function getCampaignRequiredCategory(uint256 campaignId) external view returns (bytes32) {
        return campaignRequiredCategory[campaignId];
    }

    // ── Multi-publisher campaign management ───────────────────────────────────

    /// @notice Add a publisher to the campaign's serving allowlist with an
    ///         optional per-(campaign, publisher) bond. Advertiser-only.
    ///         Allowed in both Pending and Active states — adding capacity
    ///         never strands anyone.
    ///
    ///         The publisher's `takeRateBps` is snapshotted at this moment;
    ///         later rate changes by the publisher do not affect this campaign.
    ///
    ///         If `msg.value > 0`, the value is forwarded to
    ///         `DatumChallengeBonds.lockBond` as the bond for this
    ///         (campaign, publisher) pair. Requires ChallengeBonds wired.
    function addAllowedPublisher(uint256 campaignId, address publisher)
        external payable nonReentrant
    {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (!(c.status == CampaignStatus.Pending || c.status == CampaignStatus.Active)) revert E22();
        if (!(publisher != address(0))) revert E00();
        if (!(!campaignAllowedPublisher[campaignId][publisher])) revert E71(); // already in set
        if (!(campaignAllowedPublisherCount[campaignId] < maxAllowedPublishers)) revert E11();

        // Validate the publisher: registered, not blocked, tag match.
        if (!(!publishers.isBlocked(publisher))) revert E62();
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
        if (!(pub.registered)) revert E62();

        // Per-publisher allowlist (publisher's own advertiser allowlist).
        if (publishers.allowlistEnabled(publisher)) {
            if (!(publishers.isAllowedAdvertiser(publisher, msg.sender))) revert E62();
        }

        // Tag match against the campaign's required tags.
        bytes32[] storage reqTags = _campaignTags[campaignId];
        for (uint256 i = 0; i < reqTags.length; i++) {
            if (!(_publisherTagSet[publisher][reqTags[i]])) revert E62();
        }

        // Snapshot take rate at this moment.
        uint16 rate = pub.takeRateBps;
        campaignAllowedPublisher[campaignId][publisher] = true;
        campaignPublisherTakeRate[campaignId][publisher] = rate;
        campaignAllowedPublisherCount[campaignId] += 1;

        emit PublisherAllowed(campaignId, publisher, rate);

        // Optional bond for this (campaign, publisher) pair.
        if (msg.value > 0) {
            if (!(address(challengeBonds) != address(0))) revert E00();
            challengeBonds.lockBond{value: msg.value}(campaignId, msg.sender, publisher);
        }
    }

    /// @notice Cap on per-call batch size for addAllowedPublishers — small
    ///         enough to fit comfortably within a single block's gas budget
    ///         given the per-entry validation work (publisher lookup,
    ///         allowlist check, tag-match loop, take-rate snapshot, optional
    ///         lockBond). 32 covers the legacy MAX_ALLOWED_PUBLISHERS in one
    ///         shot; larger campaigns split across multiple txs.
    uint256 public constant MAX_ADD_PUBLISHERS_BATCH = 32;

    /// @notice Batch variant of addAllowedPublisher. Each entry behaves
    ///         identically to a single addAllowedPublisher call — same
    ///         validation, same PublisherAllowed event, same bond mechanics.
    ///         Saves N-1 signatures and the per-tx fixed-cost overhead.
    ///
    ///         bondAmounts[i] is the bond locked for (campaignId, publishers[i]).
    ///         Use 0 for entries with no bond. The sum of all bondAmounts must
    ///         equal msg.value (no implicit refund, no implicit assignment).
    function addAllowedPublishers(
        uint256 campaignId,
        address[] calldata pubs,
        uint256[] calldata bondAmounts
    ) external payable nonReentrant whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (!(c.status == CampaignStatus.Pending || c.status == CampaignStatus.Active)) revert E22();
        if (!(pubs.length == bondAmounts.length)) revert E11();
        if (!(pubs.length > 0 && pubs.length <= MAX_ADD_PUBLISHERS_BATCH)) revert E11();

        // Headroom check up-front so a partial mass-add doesn't write
        // some publishers and then revert at entry N.
        if (!(campaignAllowedPublisherCount[campaignId] + pubs.length <= maxAllowedPublishers)) revert E11();

        // Sum bonds; fail loudly if msg.value mismatches.
        uint256 sumBonds;
        for (uint256 i = 0; i < bondAmounts.length; i++) sumBonds += bondAmounts[i];
        if (!(sumBonds == msg.value)) revert E11();
        if (!(sumBonds == 0 || address(challengeBonds) != address(0))) revert E00();

        bytes32[] storage reqTags = _campaignTags[campaignId];
        for (uint256 i = 0; i < pubs.length; i++) {
            address publisher = pubs[i];
            if (!(publisher != address(0))) revert E00();
            if (!(!campaignAllowedPublisher[campaignId][publisher])) revert E71();

            // Per-publisher validation (mirror of single-call addAllowedPublisher).
            if (!(!publishers.isBlocked(publisher))) revert E62();
            IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
            if (!(pub.registered)) revert E62();
            if (publishers.allowlistEnabled(publisher)) {
                if (!(publishers.isAllowedAdvertiser(publisher, msg.sender))) revert E62();
            }
            for (uint256 j = 0; j < reqTags.length; j++) {
                if (!(_publisherTagSet[publisher][reqTags[j]])) revert E62();
            }

            uint16 rate = pub.takeRateBps;
            campaignAllowedPublisher[campaignId][publisher] = true;
            campaignPublisherTakeRate[campaignId][publisher] = rate;
            campaignAllowedPublisherCount[campaignId] += 1;
            emit PublisherAllowed(campaignId, publisher, rate);

            if (bondAmounts[i] > 0) {
                challengeBonds.lockBond{value: bondAmounts[i]}(campaignId, msg.sender, publisher);
            }
        }
    }

    /// @notice Remove a publisher from the campaign's allowlist. Hard cutoff:
    ///         from the next block, claims from this publisher fail Check 3.
    ///         In-flight bonds for this (campaign, publisher) pair remain
    ///         claimable via the normal end-of-campaign return path.
    function removeAllowedPublisher(uint256 campaignId, address publisher) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (!(campaignAllowedPublisher[campaignId][publisher])) revert E01();

        campaignAllowedPublisher[campaignId][publisher] = false;
        campaignAllowedPublisherCount[campaignId] -= 1;
        // Note: per-publisher take-rate snapshot retained so any bond
        //       still in-flight has stable reference data. Storage costs
        //       are negligible vs the safety of stable references.

        emit PublisherRemoved(campaignId, publisher);
    }

    /// @notice View: is this publisher allowed to serve this campaign?
    function isAllowedPublisher(uint256 campaignId, address publisher) external view returns (bool) {
        return campaignAllowedPublisher[campaignId][publisher];
    }

    /// @notice View: per-publisher take-rate snapshot for this campaign.
    function getCampaignPublisherTakeRate(uint256 campaignId, address publisher)
        external view returns (uint16)
    {
        return campaignPublisherTakeRate[campaignId][publisher];
    }

    /// @notice View: campaign mode. 0 = OPEN, 1 = ALLOWLIST.
    function campaignMode(uint256 campaignId) external view returns (uint8) {
        return campaignAllowedPublisherCount[campaignId] > 0 ? 1 : 0;
    }

    /// @notice #1 (2026-05-12): set the per-user per-window cap for this campaign.
    ///         Both 0 = disabled. Raise locked once Active (advertiser can't
    ///         tighten mid-flight and strand user earnings); lower allowed any time.
    function setCampaignUserCap(uint256 campaignId, uint32 maxEvents, uint32 windowBlocks) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        // 0/0 is the disabled state; otherwise both must be non-zero.
        if (maxEvents != 0 || windowBlocks != 0) {
            if (!(maxEvents > 0 && windowBlocks > 0)) revert E11();
        }
        // Raise = tighter cap (smaller max OR shorter window) → locked at Pending.
        uint32 prevMax = userEventCapPerWindow[campaignId];
        uint32 prevWin = userCapWindowBlocks[campaignId];
        bool tighter = (prevMax == 0 && maxEvents > 0)
                    || (maxEvents > 0 && prevMax > 0 && maxEvents < prevMax)
                    || (windowBlocks > 0 && prevWin > 0 && windowBlocks < prevWin);
        if (tighter) {
            if (!(c.status == CampaignStatus.Pending)) revert E22();
        }
        userEventCapPerWindow[campaignId] = maxEvents;
        userCapWindowBlocks[campaignId] = windowBlocks;
        emit CampaignUserCapSet(campaignId, maxEvents, windowBlocks);
    }

    /// @notice #2-extension (2026-05-12): set the minimum cumulative settled
    ///         events a user must have (across any campaign) before participating
    ///         in this campaign. 0 = disabled. Same Pending-only raise rule.
    function setCampaignMinHistory(uint256 campaignId, uint32 minHistory) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        uint32 prev = minUserSettledHistory[campaignId];
        if (minHistory > prev) {
            if (!(c.status == CampaignStatus.Pending)) revert E22();
        }
        minUserSettledHistory[campaignId] = minHistory;
        emit CampaignMinHistorySet(campaignId, minHistory);
    }

    /// @notice People Chain identity gate. Set the minimum verified identity
    ///         level (0=disabled, 1=Reasonable, 2=KnownGood) a user must hold
    ///         in DatumPeopleChainIdentity to settle on this campaign.
    ///
    ///         Raising the bar (e.g. None → KnownGood) is locked at Pending
    ///         for the same reason as AssuranceLevel: an advertiser must not
    ///         be able to mid-flight invalidate already-engaged users.
    ///         Lowering is permitted in any state.
    ///
    ///         Settlement enforces this in `_processBatch` and OR-merges with
    ///         the user-side floor (`userMinIdentityLevel`).
    function setCampaignMinIdentityLevel(uint256 campaignId, uint8 level) external whenNotFrozen {
        if (!(level <= 2)) revert E11();
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        uint8 prev = campaignMinIdentityLevel[campaignId];
        if (level > prev) {
            if (!(c.status == CampaignStatus.Pending)) revert E22();
        }
        campaignMinIdentityLevel[campaignId] = level;
        emit CampaignMinIdentityLevelSet(campaignId, level);
    }

    /// @notice Effective People Chain identity gate level for a campaign.
    function getCampaignMinIdentityLevel(uint256 campaignId) external view returns (uint8) {
        return campaignMinIdentityLevel[campaignId];
    }

    // -------------------------------------------------------------------------
    // Bulletin Chain creative storage moved to DatumBulletinCreative.
    // (alpha-4 EIP-170 carve-out — original surface stripped below.)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Governance activation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function activateCampaign(uint256 campaignId) external whenNotFrozen {
        // Governance-driven action — gated on governance pause, not settlement.
        if (!(!pauseRegistry.pausedGovernance())) revert Paused();
        // Two authorities: governance (legacy vote path or contested-vote
        // resolution) and ActivationBonds (optimistic permissionless path
        // after timelock with no challenge).
        if (!(msg.sender == governanceContract || (activationBonds != address(0) && msg.sender == activationBonds))) revert E19();
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(c.status == CampaignStatus.Pending)) revert E20();
        c.status = CampaignStatus.Active;
        emit CampaignActivated(campaignId);
    }

    // -------------------------------------------------------------------------
    // Advertiser pause/resume
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function togglePause(uint256 campaignId, bool pause) external whenNotFrozen {
        Campaign storage c = _campaigns[campaignId];
        if (!(c.advertiser != address(0))) revert E01();
        if (!(msg.sender == c.advertiser)) revert E21();
        if (pause) {
            if (!(c.status == CampaignStatus.Active)) revert E22();
            c.status = CampaignStatus.Paused;
            emit CampaignPaused(campaignId);
        } else {
            if (!(c.status == CampaignStatus.Paused)) revert E23();
            c.status = CampaignStatus.Active;
            emit CampaignResumed(campaignId);
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle callbacks (gated to lifecycle contract)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function setCampaignStatus(uint256 campaignId, CampaignStatus newStatus) external whenNotFrozen {
        if (!(msg.sender == lifecycleContract)) revert E25();
        CampaignStatus current = _campaigns[campaignId].status;
        if (!(_validTransition(current, newStatus))) revert E67();
        _campaigns[campaignId].status = newStatus;
    }

    function _validTransition(CampaignStatus from, CampaignStatus to) internal pure returns (bool) {
        if (from == CampaignStatus.Active  && to == CampaignStatus.Completed)  return true;
        if (from == CampaignStatus.Active  && to == CampaignStatus.Terminated) return true;
        if (from == CampaignStatus.Active  && to == CampaignStatus.Pending)    return true;
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Completed)  return true;
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Terminated) return true;
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Pending)    return true;
        if (from == CampaignStatus.Pending && to == CampaignStatus.Expired)    return true;
        if (from == CampaignStatus.Pending && to == CampaignStatus.Terminated) return true;
        return false;
    }

    /// @inheritdoc IDatumCampaigns
    function setTerminationBlock(uint256 campaignId, uint256 blockNum) external {
        if (!(msg.sender == lifecycleContract)) revert E25();
        _campaigns[campaignId].terminationBlock = blockNum;
    }

    /// @inheritdoc IDatumCampaigns
    function setPendingExpiryBlock(uint256 campaignId, uint256 blockNum) external {
        if (!(msg.sender == lifecycleContract)) revert E25();
        _campaigns[campaignId].pendingExpiryBlock = blockNum;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus) {
        return _campaigns[campaignId].status;
    }

    function getCampaignAdvertiser(uint256 campaignId) external view returns (address) {
        return _campaigns[campaignId].advertiser;
    }

    /// @notice M6-fix: caller is the advertiser (cold key) registering or
    ///         rotating their per-batch hot key. Setting to address(0) revokes
    ///         delegation — subsequent batches require strict EOA cosigs from
    ///         this advertiser. The cold key is the SOLE authority over this
    ///         mapping; a compromised hot key cannot self-perpetuate.
    function setAdvertiserRelaySigner(address signer) external whenNotFrozen {
        // Advertiser-side rotation is part of the settlement trust path —
        // gate on settlement pause so a settlement-pause halts both the
        // batches AND new advertiser hot-key rotations during triage.
        if (!(!pauseRegistry.pausedSettlement())) revert Paused();
        advertiserRelaySigner[msg.sender] = signer;
        emit AdvertiserRelaySignerSet(msg.sender, signer);
    }

    /// @notice M6-fix: settlement-side reader for the advertiser's current
    ///         relay key. Exposed as a separate getter so Settlement doesn't
    ///         need to know the mapping shape.
    function getAdvertiserRelaySigner(address advertiser) external view returns (address) {
        return advertiserRelaySigner[advertiser];
    }

    function getCampaignPublisher(uint256 campaignId) external view returns (address) {
        return _campaigns[campaignId].publisher;
    }

    function getPendingExpiryBlock(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].pendingExpiryBlock;
    }

    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory) {
        return _campaignTags[campaignId];
    }

    function getCampaignRelaySigner(uint256 campaignId) external view returns (address) {
        return _campaigns[campaignId].relaySigner;
    }

    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory) {
        return _campaignPublisherTags[campaignId];
    }

    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool) {
        return _campaigns[campaignId].requiresZkProof;
    }

    /// @dev Returns 3 values: status, publisher, snapshotTakeRateBps.
    ///      Rate lookups are done via getCampaignPot(id, actionType) by ClaimValidator.
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint16 snapshotTakeRateBps
    ) {
        Campaign storage c = _campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.snapshotTakeRateBps);
    }

    /// @inheritdoc IDatumCampaigns
    function getCampaignPot(uint256 campaignId, uint8 actionType) external view returns (ActionPotConfig memory) {
        ActionPotConfig[] storage pots = _campaignPots[campaignId];
        for (uint256 i = 0; i < pots.length; i++) {
            if (pots[i].actionType == actionType) return pots[i];
        }
        revert("E01"); // pot not found
    }

    /// @inheritdoc IDatumCampaigns
    function getCampaignPots(uint256 campaignId) external view returns (ActionPotConfig[] memory) {
        return _campaignPots[campaignId];
    }

    /// @inheritdoc IDatumCampaigns
    function getCampaignViewBid(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].viewBid;
    }

    function getCampaignRewardToken(uint256 campaignId) external view returns (address) {
        return _campaigns[campaignId].rewardToken;
    }

    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].rewardPerImpression;
    }
}
