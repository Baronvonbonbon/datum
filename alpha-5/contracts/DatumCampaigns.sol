// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumCampaignsStorage.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumChallengeBonds.sol";
import "./interfaces/IDatumActivationBonds.sol";
// IDatumTagCurator / IDatumTagRegistry refs moved to DatumTagSystem
// (alpha-4 EIP-170 carve-out).
import "./interfaces/IDatumAdvertiserStake.sol";
import "./interfaces/IDatumCampaignAllowlist.sol";
import "./interfaces/IDatumTagSystem.sol";
import "./DatumCampaignsMigrationLogic.sol";

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
contract DatumCampaigns is DatumCampaignsStorage {
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

    /// v2: minimumCpmFloor + pendingTimeoutBlocks demoted from immutable to
    /// storage, gated by onlyOwnerOrPG with bounded setters + lock-once.
    function version() public pure virtual override returns (uint256) { return 2; }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /// @dev AUDIT-022: Minimum campaign budget to prevent dust campaigns (100 mDOT = 10^9 planck).
    uint256 public constant MINIMUM_BUDGET_WEI = 10**17; // 0.1 PAS (18-dec wei; was 10**9 planck pre-denomination)

    /// @notice Take rate snapshotted into open campaigns (publisher = address(0))
    ///         where there is no individual publisher rate. Governable within
    ///         the same 30%–80% range as individual publishers via setDefaultTakeRateBps.
    /// @dev Bounds match the per-publisher take rate range enforced by DatumPublishers
    ///      so the default can never escape the protocol's stated economics.
    uint16 public constant MIN_DEFAULT_TAKE_RATE_BPS = 3000;
    uint16 public constant MAX_DEFAULT_TAKE_RATE_BPS = 8000;
    // Tag caps + ceilings moved to DatumTagSystem (alpha-4 EIP-170 carve-out).

    // Safe rollout: max campaign budget cap (0 = disabled)

    // ─────────────────────────────────────────────────────────────────────
    // Governance-tunable parameters (Phase A of the parameter-governance
    // rollout). Previously `immutable`; demoted to storage so they can be
    // retuned without redeploying DatumCampaigns. Each parameter has:
    //
    //   - a runtime setter gated `onlyOwnerOrPG` (owner = phased governor;
    //     PG = ParameterGovernance with its bicameral veto window),
    //   - hard-coded MIN / MAX bounds enforced inside the setter,
    //   - a one-way `lockX()` function gated `whenOpenGovPhase` that
    //     freezes the value to the lock-once cypherpunk end-state.
    //
    // `minimumCpmFloor` is read only at campaign creation, so retuning
    // it never retroactively invalidates existing campaigns.
    // `pendingTimeoutBlocks` is snapshotted into each campaign's
    // `pendingExpiryBlock` at creation, also non-retroactive.
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Minimum CPM (rate per 1,000 events) a campaign pot may
    ///         declare at creation. Snapshot-only; existing campaigns
    ///         are unaffected by changes.

    /// @notice Block window between campaign creation and auto-expiry
    ///         if governance hasn't activated it. Snapshot into the
    ///         campaign's `pendingExpiryBlock` at create time.

    /// @notice Lock-once flag. Once `lockMinimumCpmFloor()` fires under
    ///         Phase-2 OpenGov, `setMinimumCpmFloor` reverts forever.

    /// @notice Lock-once flag for the pending-timeout parameter.

    /// @notice ParameterGovernance address authorised to retune the
    ///         parameters above through its bicameral flow. Lock-once
    ///         on first set via `setParameterGovernance` to prevent a
    ///         compromised owner from rotating PG mid-flight.

    /// @dev Hard-coded bounds. Wider than any realistic operating range;
    ///      they exist to prevent governance-attack abuse (setting the
    ///      floor to 0 / MAX_UINT, etc.). Anything inside the bounds is
    ///      still subject to PG's veto window.
    uint256 internal constant CPM_FLOOR_MIN = 1;                      // strictly > 0
    uint256 internal constant CPM_FLOOR_MAX = 10 * 10**18;            // 10 PAS/1000 imps (18-dec wei; was 10*10**10 planck)
    uint256 internal constant PENDING_TIMEOUT_MIN = 100;              // ~10 min on Paseo (6s blocks)
    uint256 internal constant PENDING_TIMEOUT_MAX = 5_256_000;        // ~1 year

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public immutable pauseRegistry;

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------


    // A5/B8-fix (2026-05-12): two-step accept handoff for governance-critical refs.
    // Pattern mirrors GovernanceRouter.setGovernor (A10). Once `bootstrapped` is
    // locked via lockBootstrap(), direct one-step setters revert — the only path
    // becomes stage (setX) + finalize (acceptX from the new address's context).
    // This blocks typo'd / fake-target takeovers post-deployment while keeping
    // the deploy script's one-shot wiring path workable.
    /// @notice One-way switch: when true, direct setters revert; only the
    ///         stage+accept handoff path is permitted. Owner flips after the
    ///         initial wiring is verified.
    event BootstrapLocked();
    event PendingRefStaged(string indexed name, address indexed pending);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------


    // Per-campaign tag arrays (_campaignTags, _campaignPublisherTags) moved
    // to DatumTagSystem (alpha-4 EIP-170 carve-out).

    // Action pots — set at creation, immutable per campaign

    // FP-2: optional challenge bonds contract (address(0) = disabled)

    // Optimistic activation: when wired, createCampaign locks an activation
    // bond and the campaign can be activated permissionlessly after timelock
    // unless challenged. address(0) = disabled (legacy governance-vote path).

    // Tag dictionary, per-publisher tag sets, lane mode + lock, tag curator,
    // tag-registry pointer, and per-campaign tag mode all moved to
    // DatumTagSystem (alpha-4 EIP-170 carve-out). Campaigns retains a single
    // pointer; ClaimValidator + Allowlist read TagSystem directly.
    event TagSystemSet(address indexed tagSystem);

    /// @notice M6-fix: per-advertiser hot-key delegation. Mirrors the publisher
    ///         relay-signer pattern (DatumPublishers.relaySigner). When set,
    ///         the advertiser may cosign L2 batches from this hot key instead
    ///         of their cold EOA. The cold key always remains able to sign
    ///         directly (strict path) and to rotate this mapping.
    event AdvertiserRelaySignerSet(address indexed advertiser, address indexed signer);

    /// @notice CB4: optional gate on createCampaign. When set non-zero,
    ///         advertisers must be adequately staked per the bonding curve.
    ///         Lock-once for cypherpunk hardening — a hostile owner can't
    ///         swap to a permissive stake contract that always returns true.
    event AdvertiserStakeSet(address indexed stakeContract);

    // ---- Allowlist snapshots (merged from DatumCampaignValidator) ----
    // Per-PUBLISHER's advertiser allowlist (set by the publisher on their inventory).

    // Multi-publisher allowlist state + setters moved to DatumCampaignAllowlist
    // (alpha-4 EIP-170 carve-out). Campaigns retains a write callback at
    // create-time via `allowlist.initializeFor(id, publisher, takeRate)` for
    // the single-publisher seed case.
    event AllowlistSet(address indexed allowlist);

    // A3: AssuranceLevel per campaign. 0=Permissive, 1=PublisherSigned, 2=DualSigned.

    // Path A (ZK): per-campaign DATUM stake minimum a user must prove to claim.
    //              0 = disabled (any user can claim if `requiresZkProof` is set).
    //              Read by ClaimValidator and passed as pub4 to DatumZKVerifier.verifyA.
    //              Raise locks at Pending (same rules as AssuranceLevel).
    //              Bounded above by `maxAllowedMinStake` (governance-set) to prevent
    //              hostile advertisers from setting absurd values that strand users.
    event CampaignMinStakeSet(uint256 indexed campaignId, uint256 minStake);

    /// @notice Governance-set upper bound on `campaignMinStake`. 0 = no cap
    ///         (any value allowed). Owner-tunable; subject to `lanesLocked`.
    event MaxAllowedMinStakeSet(uint256 amount);

    // Path A (ZK): per-campaign required interest category id. bytes32(0) = any.
    //              Passed as pub6 to DatumZKVerifier.verifyA — the user proves
    //              this category is in their published interest tree (Merkle
    //              inclusion) without revealing the rest of the set.
    //              Set/replace permitted only while Pending.
    event CampaignRequiredCategorySet(uint256 indexed campaignId, bytes32 category);

    // #1 (2026-05-12): per-user per-campaign cap. Both fields default 0 = disabled.
    // Advertiser-settable. Raising locks at Pending (matches AssuranceLevel rules
    // — can't tighten mid-flight and freeze user payouts); lowering allowed any time.
    event CampaignUserCapSet(uint256 indexed campaignId, uint32 maxEvents, uint32 windowBlocks);

    // #2-extension (2026-05-12): per-campaign minimum cumulative settled events
    // the user must have on-record before participating. Soft proof-of-history
    // sybil bar. 0 = disabled. Advertiser-settable; same Pending-only raise rule.
    event CampaignMinHistorySet(uint256 indexed campaignId, uint32 minHistory);

    // People Chain identity gate (2026-05-16): per-campaign required minimum
    // identity level the user must hold (cached in DatumPeopleChainIdentity).
    // 0 = disabled (no identity gate). 1 = Reasonable. 2 = KnownGood.
    // Advertiser-settable. Raising locked at Pending (advertiser can't
    // mid-flight invalidate users who already started participating); lowering
    // permitted any time. The check itself happens in DatumSettlement, which
    // reads campaignMinIdentityLevel(id) + identity.isVerified(user, level).
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
        // Constructor accepts ANY non-negative initial value for both
        // parameters. Production deploys must pass values inside the
        // setter bounds (the deploy script's MIN_CPM_FLOOR + a sensible
        // PENDING_TIMEOUT_BLOCKS), but unit-test deploys legitimately
        // use sub-bound values (e.g. PENDING_TIMEOUT = 5n) so settings
        // can be exercised quickly. The runtime setter is the live
        // security gate — bounded against governance abuse — and the
        // lock-once functions refuse to ratify out-of-bounds values.
        minimumCpmFloor = _minimumCpmFloor;
        pendingTimeoutBlocks = _pendingTimeoutBlocks;
        publishers = IDatumPublishers(_publishers);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        nextCampaignId = 1;
    }

    // -------------------------------------------------------------------------
    // Governance-tunable parameter setters (Phase A)
    // -------------------------------------------------------------------------

    event ParameterGovernanceSet(address indexed pg);
    event MinimumCpmFloorSet(uint256 oldValue, uint256 newValue);
    event PendingTimeoutBlocksSet(uint256 oldValue, uint256 newValue);
    event MinimumCpmFloorLocked(uint256 finalValue);
    event PendingTimeoutBlocksLocked(uint256 finalValue);

    /// @dev   Owner OR ParameterGovernance — used by setters that should be
    ///        retunable through PG's bicameral veto-window flow in addition
    ///        to the standard owner-governance path.
    modifier onlyOwnerOrPG() {
        if (!(msg.sender == owner() || msg.sender == parameterGovernance)) revert E18();
        _;
    }

    /// @notice Wire ParameterGovernance. Lock-once: once set, the address
    ///         cannot be rotated (a router upgrade is the only way to
    ///         change it post-bootstrap). Prevents a compromised owner
    ///         from re-pointing PG at a malicious target.
    function setParameterGovernance(address pg) external onlyOwner whenPlumbingUnlocked {
        if (!(pg != address(0))) revert E00();
        parameterGovernance = pg;
        emit ParameterGovernanceSet(pg);
    }

    /// @notice Retune the minimum CPM floor enforced at campaign creation.
    ///         Snapshot-at-creation: existing campaigns are unaffected.
    /// @dev    Bounded [CPM_FLOOR_MIN, CPM_FLOOR_MAX]. Reverts post-lock.
    function setMinimumCpmFloor(uint256 newFloor) external onlyOwnerOrPG whenNotFrozen {
        require(!minimumCpmFloorLocked, "locked");
        require(newFloor >= CPM_FLOOR_MIN && newFloor <= CPM_FLOOR_MAX, "out-of-bounds");
        uint256 old = minimumCpmFloor;
        minimumCpmFloor = newFloor;
        emit MinimumCpmFloorSet(old, newFloor);
    }

    /// @notice Permanently freeze the minimum CPM floor at its current
    ///         value. Phase-2 (OpenGov) gated. After lock, the floor is
    ///         effectively immutable — `setMinimumCpmFloor` reverts.
    /// @dev    Refuses to lock at zero (`CPM_FLOOR_MIN` is the smallest
    ///         lockable value) so the cypherpunk end-state can't
    ///         accidentally ratify "no floor" through a single proposal.
    function lockMinimumCpmFloor() external whenOpenGovPhase {
        require(!minimumCpmFloorLocked, "already locked");
        require(minimumCpmFloor >= CPM_FLOOR_MIN, "refuse-lock-zero");
        minimumCpmFloorLocked = true;
        emit MinimumCpmFloorLocked(minimumCpmFloor);
    }

    /// @notice Retune the pending-timeout window for new campaigns.
    ///         Snapshot-at-creation; existing campaigns retain the value
    ///         they were created under.
    /// @dev    Bounded [PENDING_TIMEOUT_MIN, PENDING_TIMEOUT_MAX].
    function setPendingTimeoutBlocks(uint256 newTimeout) external onlyOwnerOrPG whenNotFrozen {
        require(!pendingTimeoutBlocksLocked, "locked");
        require(
            newTimeout >= PENDING_TIMEOUT_MIN && newTimeout <= PENDING_TIMEOUT_MAX,
            "out-of-bounds"
        );
        uint256 old = pendingTimeoutBlocks;
        pendingTimeoutBlocks = newTimeout;
        emit PendingTimeoutBlocksSet(old, newTimeout);
    }

    /// @notice Permanently freeze the pending-timeout parameter.
    ///         Phase-2 (OpenGov) gated. Pre-lock the parameter is
    ///         retunable; post-lock the value at lock time becomes the
    ///         effective `immutable`.
    function lockPendingTimeoutBlocks() external whenOpenGovPhase {
        require(!pendingTimeoutBlocksLocked, "already locked");
        require(
            pendingTimeoutBlocks >= PENDING_TIMEOUT_MIN &&
            pendingTimeoutBlocks <= PENDING_TIMEOUT_MAX,
            "refuse-lock-out-of-bounds"
        );
        pendingTimeoutBlocksLocked = true;
        emit PendingTimeoutBlocksLocked(pendingTimeoutBlocks);
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
    function setPublishers(address addr) external onlyOwner whenPlumbingUnlocked {
        if (!(addr != address(0))) revert E00();
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
    function setChallengeBonds(address addr) external onlyOwner whenPlumbingUnlocked {
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
    function setActivationBonds(address addr) external onlyOwner whenPlumbingUnlocked {
        if (!(addr != address(0))) revert E00();
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

    // setMaxPublisherTags / setMaxCampaignTags moved to DatumTagSystem.
    // setMaxAllowedPublishers moved to DatumCampaignAllowlist.

    /// @notice One-shot wire of the carved-out allowlist module pointer.
    function setAllowlist(address addr) external onlyOwner whenPlumbingUnlocked {
        if (addr == address(0)) revert E00();
        allowlist = IDatumCampaignAllowlist(addr);
        emit AllowlistSet(addr);
    }

    /// @notice One-shot wire of the carved-out tag-system module pointer.
    function setTagSystem(address addr) external onlyOwner whenPlumbingUnlocked {
        if (addr == address(0)) revert E00();
        tagSystem = IDatumTagSystem(addr);
        emit TagSystemSet(addr);
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

    // setEnforceTagRegistry / setCampaignTagMode / lockLanes /
    // setTagRegistry / approveTag / removeApprovedTag / approveTags /
    // setTagCurator / lockTagCurator moved to DatumTagSystem
    // (alpha-4 EIP-170 carve-out).

    /// @notice CB4: wire the advertiser-stake contract. Lock-once: a hostile
    ///         owner cannot hot-swap to a permissive stake reader. Set to
    ///         address(0) at deploy if not yet ready; first non-zero write
    ///         is final.
    function setAdvertiserStake(address addr) external onlyOwner whenPlumbingUnlocked {
        if (!(addr != address(0))) revert E00();
        advertiserStake = IDatumAdvertiserStake(addr);
        emit AdvertiserStakeSet(addr);
    }

    // _isTagApproved / listApprovedTags moved to DatumTagSystem.

    // Publisher tag management (setPublisherTags / hasAllTags / etc.) moved
    // to DatumTagSystem (alpha-4 EIP-170 carve-out).

    // Community reports moved to DatumReports (alpha-4 EIP-170 carve-out).

    // -------------------------------------------------------------------------
    // Campaign creation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @notice Backwards-compat overload — equivalent to the 8-arg form with
    ///         activationBondAmount = 0 (legacy always-vote activation path).
    /// @dev Creation params bundled into a single memory struct. The public
    ///      scalar ABI is unchanged — the wrappers below pack the struct — but
    ///      `_createCampaign` then carries one memory pointer instead of eight
    ///      live stack scalars, keeping the function within the viaIR 16-slot
    ///      stack-depth limit (it sat exactly at the edge).
    struct CreateParams {
        address publisher;
        bool    requireZkProof;
        address rewardToken;
        uint256 rewardPerImpression;
        uint256 bondAmount;
        uint256 activationBondAmount;
    }

    function createCampaign(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount
    ) external payable whenNotFrozen returns (uint256 campaignId) {
        return _createCampaign(
            CreateParams(publisher, requireZkProof, rewardToken, rewardPerImpression, bondAmount, 0),
            pots, requiredTags
        );
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
        return _createCampaign(
            CreateParams(publisher, requireZkProof, rewardToken, rewardPerImpression, bondAmount, activationBondAmount),
            pots, requiredTags
        );
    }

    function _createCampaign(
        CreateParams memory p,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags
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

        if (!(msg.value > p.bondAmount + p.activationBondAmount)) revert E11();
        uint256 budgetValue = msg.value - p.bondAmount - p.activationBondAmount;
        if (!(budgetValue >= MINIMUM_BUDGET_WEI)) revert E11();
        if (!(maxCampaignBudget == 0 || budgetValue <= maxCampaignBudget)) revert E80();
        // requiredTags length check moved to DatumTagSystem.initializeCampaignTags.
        // C1-fix: forbid stranded bonds. If the advertiser passes a non-zero
        // bondAmount while ChallengeBonds isn't wired, the lockBond branch
        // below is skipped and the bondAmount portion would sit in this
        // contract permanently (no withdrawal path). Fail loudly instead.
        if (!(p.bondAmount == 0 || address(challengeBonds) != address(0))) revert E00();
        // Same protection for activation bond: forbid stranded value if the
        // ActivationBonds gateway isn't wired.
        if (!(p.activationBondAmount == 0 || activationBonds != address(0))) revert E00();

        // Validate pots
        if (!(pots.length >= 1 && pots.length <= 3)) revert E93();
        {
            bool[3] memory seen;
            uint256 totalPotBudget;
            for (uint256 i = 0; i < pots.length; i++) {
                if (!(pots[i].actionType <= 2)) revert E88();
                if (!(!seen[pots[i].actionType])) revert E93();
                seen[pots[i].actionType] = true;
                if (!(pots[i].budgetWei > 0)) revert E11();
                if (!(pots[i].dailyCapWei > 0 && pots[i].dailyCapWei <= pots[i].budgetWei)) revert E12();
                if (!(pots[i].rateWei > 0)) revert E11();
                if (pots[i].actionType == 0) {
                    if (!(pots[i].rateWei >= minimumCpmFloor)) revert E27();
                }
                totalPotBudget += pots[i].budgetWei;
            }
            if (!(totalPotBudget == budgetValue)) revert E11();
        }

        // Inline validation (merged from CampaignValidator)
        uint16 snapshot;
        address snapRelaySigner;
        bool allowlistWasEnabled;
        {
            // S12: reject blocked advertisers
            if (!(!publishers.isBlocked(msg.sender))) revert E62();

            if (p.publisher != address(0)) {
                if (!(!publishers.isBlocked(p.publisher))) revert E62();
                IDatumPublishers.Publisher memory pub = publishers.getPublisher(p.publisher);
                if (!(pub.registered)) revert E62();

                // S12: per-publisher allowlist
                allowlistWasEnabled = publishers.allowlistEnabled(p.publisher);
                if (allowlistWasEnabled) {
                    if (!(publishers.isAllowedAdvertiser(p.publisher, msg.sender))) revert E62();
                }

                // TX-1: tag matching delegated to TagSystem (returns false on miss).
                // The validation + snapshot of publisher tags happens inside
                // tagSystem.initializeCampaignTags below.

                snapshot = pub.takeRateBps;
                snapRelaySigner = publishers.relaySigner(p.publisher);
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
        // The allowlist module owns the seed state; we call its onlyCampaigns
        // entry point. Skipped only when the module isn't wired (test fixtures
        // that don't exercise the allowlist path); production always wires it.
        if (p.publisher != address(0) && address(allowlist) != address(0)) {
            allowlist.initializeFor(campaignId, p.publisher, snapshot);
        }

        if (p.rewardToken != address(0)) {
            if (!(p.rewardPerImpression > 0)) revert E11();
        }

        // Find view bid for struct
        uint256 vBid;
        for (uint256 i = 0; i < pots.length; i++) {
            if (pots[i].actionType == 0) { vBid = pots[i].rateWei; break; }
        }

        _campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            publisher: p.publisher,
            pendingExpiryBlock: block.number + pendingTimeoutBlocks,
            terminationBlock: 0,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending,
            relaySigner: snapRelaySigner,
            requiresZkProof: p.requireZkProof,
            rewardToken: p.rewardToken,
            rewardPerImpression: p.rewardPerImpression,
            viewBid: vBid
        });

        // Delegate tag validation + storage to DatumTagSystem.
        //   - Validates publisher's tag set against requiredTags (publisher !=0).
        //   - Records the required tags + snapshot of publisher's current tags.
        if (address(tagSystem) != address(0)) {
            tagSystem.initializeCampaignTags(campaignId, p.publisher, requiredTags);
        }

        // Store pots and initialize budget per pot
        for (uint256 i = 0; i < pots.length; i++) {
            _campaignPots[campaignId].push(pots[i]);
            budgetLedger.initializeBudget{value: pots[i].budgetWei}(
                campaignId, pots[i].actionType, pots[i].budgetWei, pots[i].dailyCapWei
            );
        }

        // FP-2: Lock optional bond in ChallengeBonds
        if (p.bondAmount > 0 && address(challengeBonds) != address(0)) {
            challengeBonds.lockBond{value: p.bondAmount}(campaignId, msg.sender, p.publisher);
        }

        // Optimistic activation: open the activation bond if the gateway is
        // wired and the advertiser supplied bond value. Without this, the
        // campaign sits Pending until governance activates it through the
        // legacy vote path.
        if (p.activationBondAmount > 0 && activationBonds != address(0)) {
            IDatumActivationBonds(activationBonds).openBond{value: p.activationBondAmount}(
                campaignId, msg.sender
            );
        }

        // A3: AssuranceLevel defaults to Permissive (0) for both open and
        // closed campaigns. The advertiser explicitly opts into higher levels
        // via setCampaignAssuranceLevel — no protocol-imposed paternalism.
        emit CampaignCreated(campaignId, msg.sender, p.publisher, budgetValue, snapshot);
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

    // Multi-publisher allowlist moved to DatumCampaignAllowlist.

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

    /// @notice Delegating view: reads required-tag set from DatumTagSystem.
    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory) {
        if (address(tagSystem) == address(0)) return new bytes32[](0);
        return tagSystem.getCampaignTags(campaignId);
    }

    function getCampaignRelaySigner(uint256 campaignId) external view returns (address) {
        return _campaigns[campaignId].relaySigner;
    }

    /// @notice Delegating view: reads publisher-tags snapshot from DatumTagSystem.
    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory) {
        if (address(tagSystem) == address(0)) return new bytes32[](0);
        return tagSystem.getCampaignPublisherTags(campaignId);
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

    // -------------------------------------------------------------------------
    // Non-reverting safe view variants (alpha-4 phase 8d hedge #4)
    //
    // SAFETY: every Safe variant in this block MUST be unable to revert for
    //         ANY input. They use only mapping reads (which default-return
    //         zero for unknown keys) and a single `advertiser != address(0)`
    //         existence check. If a Safe variant ever ends up reverting,
    //         it's a contract bug -- callers (notably Settlement.processBatch)
    //         interpret a revert here as fail-closed.
    //
    // The "exists" signal is `_campaigns[campaignId].advertiser != address(0)`.
    // Only createCampaign sets advertiser (always to msg.sender, never zero),
    // so the check is unambiguous: a zero advertiser means the campaign was
    // never created.
    // -------------------------------------------------------------------------

    function getCampaignAdvertiserSafe(uint256 campaignId) external view returns (bool ok, address advertiser) {
        address a = _campaigns[campaignId].advertiser;
        return (a != address(0), a);
    }

    function getCampaignAssuranceLevelSafe(uint256 campaignId) external view returns (bool ok, uint8 level) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, 0);
        return (true, campaignAssuranceLevel[campaignId]);
    }

    function getCampaignMinIdentityLevelSafe(uint256 campaignId) external view returns (bool ok, uint8 level) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, 0);
        return (true, campaignMinIdentityLevel[campaignId]);
    }

    function getCampaignRequiresZkProofSafe(uint256 campaignId) external view returns (bool ok, bool requires) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, false);
        return (true, _campaigns[campaignId].requiresZkProof);
    }

    function getCampaignRewardTokenSafe(uint256 campaignId) external view returns (bool ok, address token) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, address(0));
        return (true, _campaigns[campaignId].rewardToken);
    }

    function getCampaignRewardPerImpressionSafe(uint256 campaignId) external view returns (bool ok, uint256 rate) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, 0);
        return (true, _campaigns[campaignId].rewardPerImpression);
    }

    function getCampaignUserCapSafe(uint256 campaignId) external view returns (bool ok, uint32 maxEvents, uint32 windowBlocks) {
        if (_campaigns[campaignId].advertiser == address(0)) return (false, 0, 0);
        return (true, userEventCapPerWindow[campaignId], userCapWindowBlocks[campaignId]);
    }

    // -------------------------------------------------------------------------
    // Upgrade migration import. Campaigns is EIP-170-bound, so the heavy
    // full-import loop lives in DatumCampaignsMigrationLogic, reached via
    // DELEGATECALL (it mirrors this contract's storage layout exactly — see the
    // layout-invariant test). The off-chain migrator (scripts/migrate-campaigns.ts)
    // reads each campaign from the frozen predecessor and replays the FULL
    // per-campaign state — core struct + pots + every scalar gate — through
    // migrateDelegate.
    // -------------------------------------------------------------------------

    function getCampaignStruct(uint256 id) external view returns (Campaign memory) { return _campaigns[id]; }

    /// @dev Set the id counter so post-migration creations get fresh ids.
    function migrateBumpNextId(uint256 n) external onlyGovernance { nextCampaignId = n; }

    event MigrationLogicSet(address indexed logic);

    /// @notice Wire the DELEGATECALL migration-logic target (lock-once). Holds
    ///         the heavy full-import code off this EIP-170-bound contract.
    function setMigrationLogic(address logic) external onlyGovernance {
        if (logic == address(0)) revert E00();
        if (migrationLogic != address(0)) revert AlreadySet();
        migrationLogic = logic;
        emit MigrationLogicSet(logic);
    }

    /// @notice Governance-gated passthrough to the migration logic's
    ///         `importCampaignFull`. The off-chain migrator ABI-encodes that call
    ///         and this DELEGATECALLs it so the writes land in THIS contract's
    ///         storage. Passing raw bytes (rather than a typed struct param) keeps
    ///         the heavy nested-struct calldata decoder OUT of this EIP-170-bound
    ///         contract — it lives only in DatumCampaignsMigrationLogic.
    /// @dev    The leading selector is constrained to `importCampaignFull` so a
    ///         governance tx can't DELEGATECALL the logic's INHERITED
    ///         DatumUpgradable surface (setRouter / transferOwnership / migrate),
    ///         which would otherwise write THIS contract's owner/router slots. The
    ///         target is the lock-once, governance-set `migrationLogic`.
    function migrateDelegate(bytes calldata data) external onlyGovernance {
        if (migrationLogic == address(0)) revert RegistryUnset();
        if (bytes4(data[:4]) != DatumCampaignsMigrationLogic.importCampaignFull.selector) revert E00();
        (bool ok, ) = migrationLogic.delegatecall(data);
        if (!ok) revert E00();
    }
}
