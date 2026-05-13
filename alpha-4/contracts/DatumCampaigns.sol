// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumChallengeBonds.sol";

/// @dev B9-fix: minimal Settlement read interface for the report eligibility
///      gate. Kept inline — only one function needed and `IDatumSettlement`
///      doesn't expose this getter.
interface ISettlementReportGate {
    function userCampaignSettled(address user, uint256 campaignId, uint8 actionType)
        external view returns (uint256);
}

/// @title DatumCampaigns (Core)
/// @notice Campaign state management — creation, activation, pausing, metadata, views.
///         Includes inlined campaign validation (SE-3), tag-based targeting (TX-1),
///         and community reporting.
///
///         Multi-pricing: campaigns hold one or more action pots (view/click/
///         remote-action). Each pot has its own budget, daily cap, and rate, escrowed
///         in DatumBudgetLedger per (campaignId, actionType).
contract DatumCampaigns is IDatumCampaigns, DatumOwnable, PaseoSafeSender {
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
    uint8 public constant MAX_PUBLISHER_TAGS = 32;
    uint8 public constant MAX_CAMPAIGN_TAGS = 8;

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

    // ---- Allowlist snapshots (merged from DatumCampaignValidator) ----
    mapping(uint256 => bool) public campaignAllowlistEnabled;
    mapping(uint256 => mapping(address => bool)) public campaignAllowlistSnapshot;

    /// @notice Per-campaign toggle: when true, settlement requires the dual-sig path
    ///         (publisher + advertiser EIP-712 cosigs via DatumSettlement.settleSignedClaims).
    ///         When false (default), the relay path / direct settlement is allowed.
    ///         Advertiser-controlled — lets a campaign owner demand explicit batch-level
    ///         co-sign before any settle, catching fraud at the bookkeeping layer.
    mapping(uint256 => bool) public campaignRequiresDualSig;
    event CampaignRequiresDualSigUpdated(uint256 indexed campaignId, bool required);

    // A3: AssuranceLevel per campaign. 0=Permissive, 1=PublisherSigned, 2=DualSigned.
    // Reading uses `getCampaignAssuranceLevel` which OR-combines this with the
    // legacy `campaignRequiresDualSig` flag for backward compatibility.
    mapping(uint256 => uint8) public campaignAssuranceLevel;

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

    // A14: metadata change tracking. Counter bumps on every successful
    // setMetadata; off-chain publishers detect mid-flight creative swaps by
    // watching the version. Active campaigns also pay a cooldown between
    // changes so a publisher who just refreshed has time to re-inspect.
    uint256 public constant METADATA_COOLDOWN_BLOCKS = 14400; // ~24h at 6s/block
    mapping(uint256 => uint64) public campaignMetadataVersion;
    mapping(uint256 => uint256) public campaignMetadataLastSetBlock;

    // ---- Community reports (merged from DatumReports) ----
    mapping(uint256 => uint256) public pageReports;
    mapping(uint256 => uint256) public adReports;
    mapping(address => uint256) public publisherReports;
    mapping(address => uint256) public advertiserReports;
    mapping(uint256 => mapping(address => bool)) private _hasReportedPage;
    mapping(uint256 => mapping(address => bool)) private _hasReportedAd;

    // -------------------------------------------------------------------------
    // Bulletin Chain creative storage (audit pass 3.7)
    // -------------------------------------------------------------------------
    //
    // Parallel-to-IPFS storage path. Advertisers upload creatives to the
    // Polkadot Bulletin Chain (Paseo: wss://paseo-bulletin-rpc.polkadot.io),
    // receive an IPFS-compatible CID + (block, index) reference, and post
    // those refs here for canonical resolution. Frontends prefer Bulletin Chain
    // when set; otherwise fall back to the existing `metadata` IPFS hash.
    //
    // Bulletin Chain retention is ~2 weeks on Paseo; the contract enforces an
    // upper bound on per-renewal expiry advancement so a single fraudulent
    // confirmBulletinRenewal can't claim a year of retention in one call.
    //
    // Storage rent is paid in *authorization quota* on Bulletin Chain (not DOT),
    // so the EVM contract can't directly pay renewers. Instead an optional
    // escrow per campaign lets advertisers reimburse renewers a fixed DOT
    // amount per confirmed renewal. Renewer set is advertiser-gated (default
    // owner-only, optional allowlist or fully-open per-campaign flag).

    struct BulletinRef {
        bytes32 cidDigest;             // multihash digest (Blake2b-256 by default)
        uint8   cidCodec;              // 0 = raw, 1 = dag-pb manifest, future codecs reserved
        uint32  bulletinBlock;         // current Bulletin Chain block number
        uint32  bulletinIndex;         // current index within that Bulletin Chain block
        uint64  expiryHubBlock;        // Hub-block estimate when Bulletin retention expires
        uint64  retentionHorizonBlock; // advertiser-set regulatory horizon (renew until this Hub-block)
        uint32  version;               // bumps on every set/renew (mirror of campaignMetadataVersion)
    }
    mapping(uint256 => BulletinRef) public campaignBulletin;

    // Per-campaign DOT escrow for renewer reimbursement. Permissionless funding.
    mapping(uint256 => uint256) public bulletinRenewalEscrow;

    // Renewer trust gradient: advertiser picks per-campaign.
    //   default — advertiser-only renewal (no escrow needed)
    //   allowlist — advertiser approves specific renewer addresses
    //   open — anyone can renew (highest risk; advertiser opts in)
    mapping(uint256 => mapping(address => bool)) public approvedBulletinRenewer;
    mapping(uint256 => bool) public openBulletinRenewal;

    // Renewer reward in planck, paid from escrow per confirmed renewal.
    // Owner-tunable up to MAX cap; bounded to prevent ratcheting griefing.
    uint256 public bulletinRenewerReward = 10**8; // 0.01 DOT default
    uint256 public constant MAX_BULLETIN_RENEWER_REWARD = 10 * 10**10; // 10 DOT cap

    // Bound on per-renewal expiry advancement. Bulletin Chain retention is
    // ~2 weeks on Paseo; allow a small buffer for clock skew + chain timing.
    // 220_000 Hub-blocks @ 6s ≈ 15.3 days.
    uint64 public constant MAX_RETENTION_ADVANCE_BLOCKS = 220_000;

    // Lead time before expiry for the permissionless `requestBulletinRenewal`
    // event to fire. ~1 day @ 6s blocks.
    uint64 public constant BULLETIN_RENEWAL_LEAD_BLOCKS = 14_400;

    event BulletinCreativeSet(
        uint256 indexed campaignId,
        bytes32 indexed cidDigest,
        uint8 codec,
        uint32 bulletinBlock,
        uint32 bulletinIndex,
        uint64 expiryHubBlock,
        uint64 retentionHorizonBlock,
        uint32 version
    );
    event BulletinCreativeRenewed(
        uint256 indexed campaignId,
        address indexed renewer,
        uint32 newBlock,
        uint32 newIndex,
        uint64 newExpiryHubBlock,
        uint32 version
    );
    event BulletinRenewalDue(uint256 indexed campaignId, uint64 expiryHubBlock, uint256 escrowBalance);
    event BulletinRenewalEscrowFunded(uint256 indexed campaignId, address indexed funder, uint256 amount, uint256 totalEscrow);
    event BulletinRenewalEscrowWithdrawn(uint256 indexed campaignId, address indexed recipient, uint256 amount);
    event BulletinRenewerAuthorized(uint256 indexed campaignId, address indexed renewer, bool authorized);
    event BulletinRenewalModeChanged(uint256 indexed campaignId, bool open);
    event BulletinRenewerRewardUpdated(uint256 oldReward, uint256 newReward);
    event BulletinCreativeExpired(uint256 indexed campaignId);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        uint256 _minimumCpmFloor,
        uint256 _pendingTimeoutBlocks,
        address _publishers,
        address _pauseRegistry
    ) {
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
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
        require(addr != address(0), "E00");
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
        require(c != address(0) && msg.sender == c, "E19");
        emit ContractReferenceChanged("settlement", settlementContract, c);
        settlementContract = c;
        pendingSettlementContract = address(0);
    }

    function setGovernanceContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
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
        require(c != address(0) && msg.sender == c, "E19");
        emit ContractReferenceChanged("governance", governanceContract, c);
        governanceContract = c;
        pendingGovernanceContract = address(0);
    }

    function setLifecycleContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
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
        require(c != address(0) && msg.sender == c, "E19");
        emit ContractReferenceChanged("lifecycle", lifecycleContract, c);
        lifecycleContract = c;
        pendingLifecycleContract = address(0);
    }

    /// @dev Cypherpunk lock-once: publishers is set in the constructor (non-zero
    ///      at deploy); this setter therefore reverts on every call —
    ///      effectively immutable. Kept in the ABI to surface the lock semantics
    ///      to indexers/tooling rather than silently dropping the symbol.
    function setPublishers(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(publishers) == address(0), "already set");
        emit ContractReferenceChanged("publishers", address(publishers), addr);
        publishers = IDatumPublishers(addr);
    }

    function setBudgetLedger(address addr) external onlyOwner {
        require(addr != address(0), "E00");
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
        require(c != address(0) && msg.sender == c, "E19");
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), c);
        budgetLedger = IDatumBudgetLedger(c);
        pendingBudgetLedger = address(0);
    }

    /// @notice A5/B8-fix: one-way switch. After this, the four governance-
    ///         critical setters above can only stage pending addresses; the
    ///         new contract must call its acceptX() to finalize.
    function lockBootstrap() external onlyOwner {
        require(!bootstrapped, "already bootstrapped");
        bootstrapped = true;
        emit BootstrapLocked();
    }

    /// @notice Set challenge bonds contract.
    /// @dev    D3 cypherpunk lock-once on first non-zero write. ChallengeBonds
    ///         holds advertiser bond DOT; a hot-swap could redirect lockBond
    ///         calls to a hostile contract. address(0) leaves the feature off
    ///         and is the initial state; once set non-zero it's frozen.
    function setChallengeBonds(address addr) external onlyOwner {
        require(address(challengeBonds) == address(0), "already set");
        emit ContractReferenceChanged("challengeBonds", address(challengeBonds), addr);
        challengeBonds = IDatumChallengeBonds(addr);
    }

    /// @notice Set the maximum campaign budget. 0 disables the cap.
    /// @notice Update the take rate applied to open campaigns (publisher = address(0)).
    /// @dev Bounded to the same 30%–80% range as individual publisher take rates so
    ///      governance can't push the default outside the protocol's stated economics.
    event DefaultTakeRateUpdated(uint16 oldBps, uint16 newBps);
    function setDefaultTakeRateBps(uint16 bps) external onlyOwner {
        require(bps >= MIN_DEFAULT_TAKE_RATE_BPS && bps <= MAX_DEFAULT_TAKE_RATE_BPS, "E11");
        emit DefaultTakeRateUpdated(defaultTakeRateBps, bps);
        defaultTakeRateBps = bps;
    }

    function setMaxCampaignBudget(uint256 amount) external onlyOwner {
        maxCampaignBudget = amount;
        emit MaxCampaignBudgetSet(amount);
    }

    /// @notice Enable or disable tag registry enforcement.
    function setEnforceTagRegistry(bool enforced) external onlyOwner {
        enforceTagRegistry = enforced;
        emit TagRegistryEnforced(enforced);
    }

    /// @notice Add a tag to the approved registry.
    function approveTag(bytes32 tag) external onlyOwner {
        require(tag != bytes32(0), "E00");
        require(!approvedTags[tag], "E15");
        approvedTags[tag] = true;
        _approvedTagList.push(tag);
        _approvedTagIndex[tag] = _approvedTagList.length;
        emit TagApproved(tag);
    }

    /// @notice Remove a tag from the approved registry (swap-and-pop).
    function removeApprovedTag(bytes32 tag) external onlyOwner {
        require(approvedTags[tag], "E01");
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
        for (uint256 i = 0; i < tags.length; i++) {
            require(tags[i] != bytes32(0), "E00");
            if (!approvedTags[tags[i]]) {
                approvedTags[tags[i]] = true;
                _approvedTagList.push(tags[i]);
                _approvedTagIndex[tags[i]] = _approvedTagList.length;
                emit TagApproved(tags[i]);
            }
        }
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
    function setPublisherTags(bytes32[] calldata tagHashes) external {
        require(!pauseRegistry.paused(), "P");
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(msg.sender);
        require(pub.registered, "Not registered");
        require(tagHashes.length <= MAX_PUBLISHER_TAGS, "E65");

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
        bool enforce = enforceTagRegistry;
        for (uint256 i = 0; i < tagHashes.length; i++) {
            require(tagHashes[i] != bytes32(0), "E00");
            if (enforce) require(approvedTags[tagHashes[i]], "E81");
            _publisherTags[msg.sender].push(tagHashes[i]);
            _publisherTagSet[msg.sender][tagHashes[i]] = true;
            // Re-adding a previously-pending tag aborts its removal.
            tagRemovalEffectiveBlock[msg.sender][tagHashes[i]] = 0;
        }

        emit TagsUpdated(msg.sender, tagHashes);
    }

    /// @notice Returns all tags for a publisher.
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    /// @notice Returns true if publisher has ALL of the required tags (AND logic).
    ///         A8: tags in their post-removal grace window still count as held.
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool) {
        if (requiredTags.length == 0) return true;
        require(requiredTags.length <= MAX_CAMPAIGN_TAGS, "E66");
        for (uint256 i = 0; i < requiredTags.length; i++) {
            if (_publisherTagSet[publisher][requiredTags[i]]) continue;
            uint256 eff = tagRemovalEffectiveBlock[publisher][requiredTags[i]];
            if (eff != 0 && block.number < eff) continue; // still in grace
            return false;
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // Community reports (merged from DatumReports)
    // -------------------------------------------------------------------------

    /// @notice B9-fix (2026-05-12): minimum settled events on this campaign the
    ///         reporter must have before they can file a report. Sybil-resistant
    ///         by construction: each settled event has been through publisher
    ///         cosig + rate check + (where required) ZK proof. Fresh sock-puppet
    ///         addresses can't accumulate `userCampaignSettled` without serving
    ///         real impressions, so the protocol's own ledger gates eligibility.
    ///         No token-holding requirement — real users qualify automatically.
    uint256 public constant MIN_EVENTS_TO_REPORT = 1;

    /// @dev B9-fix: skipped when `settlementContract == address(0)` so test
    ///      fixtures and early-bootstrap deployments without a wired settlement
    ///      can still exercise the report path. In production, settlement is
    ///      always wired before campaigns go live.
    function _requireReporterEligible(uint256 campaignId) internal view {
        address s = settlementContract;
        if (s == address(0)) return;
        // Sum settled events across view/click/action — any genuine settled
        // event on this campaign qualifies the reporter.
        uint256 total = ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 0)
                      + ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 1)
                      + ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 2);
        require(total >= MIN_EVENTS_TO_REPORT, "E62"); // not a real audience member
    }

    /// @notice Report a campaign's page (publisher content violation).
    function reportPage(uint256 campaignId, uint8 reason) external {
        require(reason >= 1 && reason <= 5, "E68");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(!_hasReportedPage[campaignId][msg.sender], "E68");
        _requireReporterEligible(campaignId);
        _hasReportedPage[campaignId][msg.sender] = true;
        pageReports[campaignId]++;
        address pub = c.publisher;
        if (pub != address(0)) publisherReports[pub]++;
        emit PageReported(campaignId, pub, msg.sender, reason);
    }

    /// @notice Report a campaign's ad creative (advertiser content violation).
    function reportAd(uint256 campaignId, uint8 reason) external {
        require(reason >= 1 && reason <= 5, "E68");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(!_hasReportedAd[campaignId][msg.sender], "E68");
        _requireReporterEligible(campaignId);
        _hasReportedAd[campaignId][msg.sender] = true;
        adReports[campaignId]++;
        advertiserReports[c.advertiser]++;
        emit AdReported(campaignId, c.advertiser, msg.sender, reason);
    }

    // -------------------------------------------------------------------------
    // Campaign creation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function createCampaign(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount
    ) external payable nonReentrant returns (uint256 campaignId) {
        require(!pauseRegistry.paused(), "P");
        require(msg.value > bondAmount, "E11");
        uint256 budgetValue = msg.value - bondAmount;
        require(budgetValue >= MINIMUM_BUDGET_PLANCK, "E11");
        require(maxCampaignBudget == 0 || budgetValue <= maxCampaignBudget, "E80");
        require(requiredTags.length <= MAX_CAMPAIGN_TAGS, "E66");
        // C1-fix: forbid stranded bonds. If the advertiser passes a non-zero
        // bondAmount while ChallengeBonds isn't wired, the lockBond branch
        // below is skipped and the bondAmount portion would sit in this
        // contract permanently (no withdrawal path). Fail loudly instead.
        require(bondAmount == 0 || address(challengeBonds) != address(0), "E00");

        // Validate pots
        require(pots.length >= 1 && pots.length <= 3, "E93");
        {
            bool[3] memory seen;
            uint256 totalPotBudget;
            for (uint256 i = 0; i < pots.length; i++) {
                require(pots[i].actionType <= 2, "E88");
                require(!seen[pots[i].actionType], "E93");
                seen[pots[i].actionType] = true;
                require(pots[i].budgetPlanck > 0, "E11");
                require(pots[i].dailyCapPlanck > 0 && pots[i].dailyCapPlanck <= pots[i].budgetPlanck, "E12");
                require(pots[i].ratePlanck > 0, "E11");
                if (pots[i].actionType == 0) {
                    require(pots[i].ratePlanck >= minimumCpmFloor, "E27");
                }
                totalPotBudget += pots[i].budgetPlanck;
            }
            require(totalPotBudget == budgetValue, "E11");
        }

        // Inline validation (merged from CampaignValidator)
        uint16 snapshot;
        address snapRelaySigner;
        bytes32[] memory snapPubTags;
        bool allowlistWasEnabled;
        {
            // S12: reject blocked advertisers
            require(!publishers.isBlocked(msg.sender), "E62");

            if (publisher != address(0)) {
                require(!publishers.isBlocked(publisher), "E62");
                IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
                require(pub.registered, "E62");

                // S12: per-publisher allowlist
                allowlistWasEnabled = publishers.allowlistEnabled(publisher);
                if (allowlistWasEnabled) {
                    require(publishers.isAllowedAdvertiser(publisher, msg.sender), "E62");
                }

                // TX-1: tag matching
                if (requiredTags.length > 0) {
                    for (uint256 i = 0; i < requiredTags.length; i++) {
                        require(_publisherTagSet[publisher][requiredTags[i]], "E62");
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

        if (rewardToken != address(0)) {
            require(rewardPerImpression > 0, "E11");
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
            metadata: bytes32(0),
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

        // A3: AssuranceLevel defaults to Permissive (0) for both open and
        // closed campaigns. The advertiser explicitly opts into higher levels
        // via setCampaignAssuranceLevel — no protocol-imposed paternalism.
        // The legacy `campaignRequiresDualSig` toggle still works as the
        // historical path to L2 and is OR-merged in getCampaignAssuranceLevel.
        emit CampaignCreated(campaignId, msg.sender, publisher, budgetValue, snapshot);
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @dev A14-note (2026-05-12): intentionally NO global pause gate. Advertisers
    ///      should retain the ability to update creative metadata during a pause —
    ///      pause is for blocking *settlement*, not for freezing all state.
    ///      Do not "fix" this by adding `!pauseRegistry.paused()`.
    function setMetadata(uint256 campaignId, bytes32 metadataHash) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");

        // A14: cooldown applies once the campaign is visible to publishers.
        // Pending-status creatives can be revised freely until activation.
        if (c.status != CampaignStatus.Pending) {
            uint256 last = campaignMetadataLastSetBlock[campaignId];
            require(last == 0 || block.number >= last + METADATA_COOLDOWN_BLOCKS, "E22");
        }
        c.metadata = metadataHash;
        campaignMetadataLastSetBlock[campaignId] = block.number;
        uint64 v = campaignMetadataVersion[campaignId] + 1;
        campaignMetadataVersion[campaignId] = v;
        emit CampaignMetadataSet(campaignId, metadataHash, v);
    }

    /// @notice Toggle whether this campaign requires the dual-sig settlement path.
    ///         When true, single-sig (relay) settlement attempts will reject all
    ///         claims with reason code 24. Only the advertiser can flip this,
    ///         and only **before activation**. Once Active, the toggle is locked
    ///         to prevent the advertiser from freezing user earnings mid-flight
    ///         by demanding co-sigs they then refuse to provide.
    function setCampaignRequiresDualSig(uint256 campaignId, bool required) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        require(c.status == CampaignStatus.Pending, "E22");
        campaignRequiresDualSig[campaignId] = required;
        emit CampaignRequiresDualSigUpdated(campaignId, required);
    }

    /// @notice Read the dual-sig requirement for a campaign. Settlement consults this.
    function getCampaignRequiresDualSig(uint256 campaignId) external view returns (bool) {
        return campaignRequiresDualSig[campaignId];
    }

    /// @notice A3: Effective AssuranceLevel. Reads the canonical storage and
    ///         OR-merges the legacy `campaignRequiresDualSig` flag so old
    ///         deployments continue to enforce dual-sig.
    function getCampaignAssuranceLevel(uint256 campaignId) public view returns (uint8) {
        uint8 stored = campaignAssuranceLevel[campaignId];
        if (campaignRequiresDualSig[campaignId] && stored < 2) return 2;
        return stored;
    }

    /// @notice A3: Set the campaign's AssuranceLevel. Raising the bar is
    ///         locked once Active (per the same logic as `setCampaignRequiresDualSig`:
    ///         the advertiser can't freeze user earnings mid-flight by adding
    ///         new sig requirements they then refuse to provide). Lowering
    ///         is permitted at any time — less proof never invalidates past
    ///         claims and gives the advertiser an escape if their cosign
    ///         pipeline breaks.
    function setCampaignAssuranceLevel(uint256 campaignId, uint8 level) external {
        require(level <= 2, "E11");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        uint8 current = getCampaignAssuranceLevel(campaignId);
        if (level > current) {
            require(c.status == CampaignStatus.Pending, "E22");
        }
        campaignAssuranceLevel[campaignId] = level;
        // Lowering below 2: clear the legacy flag so the OR-read agrees.
        if (level < 2 && campaignRequiresDualSig[campaignId]) {
            campaignRequiresDualSig[campaignId] = false;
            emit CampaignRequiresDualSigUpdated(campaignId, false);
        }
        emit CampaignAssuranceLevelSet(campaignId, level);
    }

    /// @notice #1 (2026-05-12): set the per-user per-window cap for this campaign.
    ///         Both 0 = disabled. Raise locked once Active (advertiser can't
    ///         tighten mid-flight and strand user earnings); lower allowed any time.
    function setCampaignUserCap(uint256 campaignId, uint32 maxEvents, uint32 windowBlocks) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        // 0/0 is the disabled state; otherwise both must be non-zero.
        if (maxEvents != 0 || windowBlocks != 0) {
            require(maxEvents > 0 && windowBlocks > 0, "E11");
        }
        // Raise = tighter cap (smaller max OR shorter window) → locked at Pending.
        uint32 prevMax = userEventCapPerWindow[campaignId];
        uint32 prevWin = userCapWindowBlocks[campaignId];
        bool tighter = (prevMax == 0 && maxEvents > 0)
                    || (maxEvents > 0 && prevMax > 0 && maxEvents < prevMax)
                    || (windowBlocks > 0 && prevWin > 0 && windowBlocks < prevWin);
        if (tighter) {
            require(c.status == CampaignStatus.Pending, "E22");
        }
        userEventCapPerWindow[campaignId] = maxEvents;
        userCapWindowBlocks[campaignId] = windowBlocks;
        emit CampaignUserCapSet(campaignId, maxEvents, windowBlocks);
    }

    /// @notice #2-extension (2026-05-12): set the minimum cumulative settled
    ///         events a user must have (across any campaign) before participating
    ///         in this campaign. 0 = disabled. Same Pending-only raise rule.
    function setCampaignMinHistory(uint256 campaignId, uint32 minHistory) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        uint32 prev = minUserSettledHistory[campaignId];
        if (minHistory > prev) {
            require(c.status == CampaignStatus.Pending, "E22");
        }
        minUserSettledHistory[campaignId] = minHistory;
        emit CampaignMinHistorySet(campaignId, minHistory);
    }

    // -------------------------------------------------------------------------
    // Bulletin Chain creative storage (audit pass 3.7)
    // -------------------------------------------------------------------------

    /// @notice Set or replace the Bulletin Chain reference for this campaign's
    ///         creative. Advertiser-only. The advertiser uploads the creative
    ///         to Bulletin Chain off-chain (PAPI/Console UI), receives a
    ///         `(CID, block, index)` triple, then registers it here.
    /// @dev    Mirrors `setMetadata` semantics:
    ///         - while Pending: free re-uploads
    ///         - while Active/Paused: subject to METADATA_COOLDOWN_BLOCKS between updates
    ///         - bumps a per-campaign version counter on every successful call
    /// @param  campaignId            target campaign
    /// @param  cidDigest             32-byte multihash digest from Bulletin Chain
    /// @param  cidCodec              0 = raw, 1 = dag-pb manifest
    /// @param  bulletinBlock         block number on Bulletin Chain where the
    ///                               TransactionStorage.store transaction landed
    /// @param  bulletinIndex         index of that transaction within the block
    /// @param  retentionHorizonBlock Hub-block at or before which the advertiser
    ///                               commits to keeping the creative alive
    ///                               (regulatory retention horizon)
    function setBulletinCreative(
        uint256 campaignId,
        bytes32 cidDigest,
        uint8   cidCodec,
        uint32  bulletinBlock,
        uint32  bulletinIndex,
        uint64  retentionHorizonBlock
    ) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        require(cidDigest != bytes32(0), "E00");
        require(bulletinBlock > 0, "E11");
        require(retentionHorizonBlock > block.number, "E11");

        BulletinRef storage br = campaignBulletin[campaignId];

        // Cooldown only applies to subsequent updates on a non-Pending campaign.
        // The first upload on any status is free (no prior version to gate against).
        if (c.status != CampaignStatus.Pending && br.cidDigest != bytes32(0)) {
            uint64 lastSet = br.expiryHubBlock > MAX_RETENTION_ADVANCE_BLOCKS
                ? br.expiryHubBlock - MAX_RETENTION_ADVANCE_BLOCKS
                : 0;
            require(block.number >= lastSet + METADATA_COOLDOWN_BLOCKS, "E22");
        }

        // Expiry estimate: capped at MAX_RETENTION_ADVANCE_BLOCKS from now.
        // The actual Bulletin Chain retention is shorter than this; the bound
        // protects against fraudulent inflation if the function ever becomes
        // callable by a non-advertiser path.
        uint64 expiry = uint64(block.number) + MAX_RETENTION_ADVANCE_BLOCKS;

        br.cidDigest = cidDigest;
        br.cidCodec = cidCodec;
        br.bulletinBlock = bulletinBlock;
        br.bulletinIndex = bulletinIndex;
        br.expiryHubBlock = expiry;
        br.retentionHorizonBlock = retentionHorizonBlock;
        br.version += 1;

        emit BulletinCreativeSet(
            campaignId, cidDigest, cidCodec, bulletinBlock, bulletinIndex,
            expiry, retentionHorizonBlock, br.version
        );
    }

    /// @notice Confirm a successful Bulletin Chain `transactionStorage.renew`.
    ///         Gated by the renewer trust gradient:
    ///           - msg.sender == c.advertiser: always allowed (free)
    ///           - approvedBulletinRenewer[id][msg.sender]: allowed if advertiser approved
    ///           - openBulletinRenewal[id]: allowed for anyone
    ///         Non-advertiser callers are paid `bulletinRenewerReward` from the
    ///         campaign's renewal escrow.
    /// @dev    Expiry advancement is capped at MAX_RETENTION_ADVANCE_BLOCKS so
    ///         a fake confirmation can't claim more retention than Bulletin
    ///         Chain actually grants. CID does NOT change on renewal — only
    ///         the `(bulletinBlock, bulletinIndex, expiryHubBlock)` triple.
    function confirmBulletinRenewal(
        uint256 campaignId,
        uint32  newBulletinBlock,
        uint32  newBulletinIndex
    ) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        BulletinRef storage br = campaignBulletin[campaignId];
        require(br.cidDigest != bytes32(0), "E01"); // no ref to renew

        bool isAdvertiser = (msg.sender == c.advertiser);
        if (!isAdvertiser) {
            require(
                openBulletinRenewal[campaignId] || approvedBulletinRenewer[campaignId][msg.sender],
                "E18"
            );
        }

        require(newBulletinBlock > br.bulletinBlock, "E11"); // monotonic
        require(newBulletinBlock > 0, "E11");

        // Bounded expiry advancement: at most one Bulletin retention period
        // ahead of the current Hub block.
        uint64 newExpiry = uint64(block.number) + MAX_RETENTION_ADVANCE_BLOCKS;

        br.bulletinBlock = newBulletinBlock;
        br.bulletinIndex = newBulletinIndex;
        br.expiryHubBlock = newExpiry;
        br.version += 1;

        // Pay renewer reward from escrow if caller is not the advertiser.
        if (!isAdvertiser) {
            uint256 reward = bulletinRenewerReward;
            uint256 escrow = bulletinRenewalEscrow[campaignId];
            if (reward > 0 && escrow >= reward) {
                bulletinRenewalEscrow[campaignId] = escrow - reward;
                _safeSend(msg.sender, reward);
            }
        }

        emit BulletinCreativeRenewed(
            campaignId, msg.sender, newBulletinBlock, newBulletinIndex, newExpiry, br.version
        );
    }

    /// @notice Permissionless: emit a `BulletinRenewalDue` event when this
    ///         campaign's Bulletin Chain creative is approaching expiry.
    ///         Off-chain renewers listen for this and call
    ///         `transactionStorage.renew` on Bulletin Chain followed by
    ///         `confirmBulletinRenewal` here. Free to call by anyone; rate
    ///         self-limited by the expiry condition (event won't fire again
    ///         until a renewal advances the expiry).
    function requestBulletinRenewal(uint256 campaignId) external {
        BulletinRef storage br = campaignBulletin[campaignId];
        require(br.cidDigest != bytes32(0), "E01");
        require(
            br.expiryHubBlock > block.number &&
            br.expiryHubBlock - block.number <= BULLETIN_RENEWAL_LEAD_BLOCKS,
            "E22"
        );
        emit BulletinRenewalDue(campaignId, br.expiryHubBlock, bulletinRenewalEscrow[campaignId]);
    }

    /// @notice Mark a Bulletin Chain creative as expired (permissionless).
    ///         Only callable once retention has actually lapsed. Frontends
    ///         can use this event to fall back to the IPFS hash for display.
    function markBulletinExpired(uint256 campaignId) external {
        BulletinRef storage br = campaignBulletin[campaignId];
        require(br.cidDigest != bytes32(0), "E01");
        require(block.number >= br.expiryHubBlock, "E22");
        // Zero the CID digest so frontends fall back to IPFS metadata.
        // Preserve other fields for historical/audit visibility.
        br.cidDigest = bytes32(0);
        emit BulletinCreativeExpired(campaignId);
    }

    // -------- Renewal escrow (advertiser-funded, advertiser-withdrawable) -----

    /// @notice Fund the renewal escrow for a campaign. Permissionless funding
    ///         (anyone can top up — useful for collective campaigns).
    function fundBulletinRenewalEscrow(uint256 campaignId) external payable {
        require(_campaigns[campaignId].advertiser != address(0), "E01");
        require(msg.value > 0, "E11");
        bulletinRenewalEscrow[campaignId] += msg.value;
        emit BulletinRenewalEscrowFunded(
            campaignId, msg.sender, msg.value, bulletinRenewalEscrow[campaignId]
        );
    }

    /// @notice Withdraw unused escrow to a recipient. Advertiser-only.
    function withdrawBulletinRenewalEscrow(uint256 campaignId, address recipient, uint256 amount) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        require(recipient != address(0), "E00");
        require(amount > 0 && amount <= bulletinRenewalEscrow[campaignId], "E11");
        bulletinRenewalEscrow[campaignId] -= amount;
        emit BulletinRenewalEscrowWithdrawn(campaignId, recipient, amount);
        _safeSend(recipient, amount);
    }

    // -------- Renewer authorization (advertiser-controlled) ------------------

    /// @notice Approve / revoke a specific renewer address for this campaign.
    function setApprovedBulletinRenewer(uint256 campaignId, address renewer, bool approved) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        require(renewer != address(0), "E00");
        approvedBulletinRenewer[campaignId][renewer] = approved;
        emit BulletinRenewerAuthorized(campaignId, renewer, approved);
    }

    /// @notice Toggle fully-open renewal for this campaign. When true, anyone
    ///         can call `confirmBulletinRenewal` and drain renewer reward.
    ///         Advertiser is responsible for sizing the escrow to match risk.
    function setOpenBulletinRenewal(uint256 campaignId, bool open) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        openBulletinRenewal[campaignId] = open;
        emit BulletinRenewalModeChanged(campaignId, open);
    }

    // -------- Owner-tunable renewer reward (bounded) -------------------------

    /// @notice Update the DOT reward paid per confirmed renewal. Owner-only,
    ///         bounded at MAX_BULLETIN_RENEWER_REWARD to prevent ratcheting.
    function setBulletinRenewerReward(uint256 newReward) external onlyOwner {
        require(newReward <= MAX_BULLETIN_RENEWER_REWARD, "above cap");
        uint256 old = bulletinRenewerReward;
        bulletinRenewerReward = newReward;
        emit BulletinRenewerRewardUpdated(old, newReward);
    }

    // -------- Views ----------------------------------------------------------

    /// @notice Returns the campaign's current Bulletin Chain creative reference.
    ///         If `cidDigest == 0`, no Bulletin reference is set and the
    ///         frontend should fall back to the legacy IPFS `metadata` hash.
    function getBulletinCreative(uint256 campaignId) external view returns (BulletinRef memory) {
        return campaignBulletin[campaignId];
    }

    /// @notice Convenience view: is the Bulletin creative due for renewal soon?
    function isBulletinRenewalDue(uint256 campaignId) external view returns (bool) {
        BulletinRef storage br = campaignBulletin[campaignId];
        if (br.cidDigest == bytes32(0)) return false;
        if (br.expiryHubBlock <= block.number) return false;
        return br.expiryHubBlock - block.number <= BULLETIN_RENEWAL_LEAD_BLOCKS;
    }

    // -------------------------------------------------------------------------
    // Governance activation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function activateCampaign(uint256 campaignId) external {
        require(!pauseRegistry.paused(), "P");
        require(msg.sender == governanceContract, "E19");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(c.status == CampaignStatus.Pending, "E20");
        c.status = CampaignStatus.Active;
        emit CampaignActivated(campaignId);
    }

    // -------------------------------------------------------------------------
    // Advertiser pause/resume
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function togglePause(uint256 campaignId, bool pause) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        if (pause) {
            require(c.status == CampaignStatus.Active, "E22");
            c.status = CampaignStatus.Paused;
            emit CampaignPaused(campaignId);
        } else {
            require(c.status == CampaignStatus.Paused, "E23");
            c.status = CampaignStatus.Active;
            emit CampaignResumed(campaignId);
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle callbacks (gated to lifecycle contract)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function setCampaignStatus(uint256 campaignId, CampaignStatus newStatus) external {
        require(msg.sender == lifecycleContract, "E25");
        CampaignStatus current = _campaigns[campaignId].status;
        require(_validTransition(current, newStatus), "E67");
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
        require(msg.sender == lifecycleContract, "E25");
        _campaigns[campaignId].terminationBlock = blockNum;
    }

    /// @inheritdoc IDatumCampaigns
    function setPendingExpiryBlock(uint256 campaignId, uint256 blockNum) external {
        require(msg.sender == lifecycleContract, "E25");
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

    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32) {
        return _campaigns[campaignId].metadata;
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
