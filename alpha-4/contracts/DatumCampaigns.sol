// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumChallengeBonds.sol";

/// @title DatumCampaigns (Core)
/// @notice Campaign state management — creation, activation, pausing, metadata, views.
///         Includes inlined campaign validation (SE-3), tag-based targeting (TX-1),
///         and community reporting.
///
///         Multi-pricing: campaigns hold one or more action pots (view/click/
///         remote-action). Each pot has its own budget, daily cap, and rate, escrowed
///         in DatumBudgetLedger per (campaignId, actionType).
contract DatumCampaigns is IDatumCampaigns, ReentrancyGuard, DatumOwnable {
    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /// @dev AUDIT-022: Minimum campaign budget to prevent dust campaigns (100 mDOT = 10^9 planck).
    uint256 public constant MINIMUM_BUDGET_PLANCK = 10**9;

    uint16 private constant DEFAULT_TAKE_RATE_BPS = 5000;
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

    // ---- Community reports (merged from DatumReports) ----
    mapping(uint256 => uint256) public pageReports;
    mapping(uint256 => uint256) public adReports;
    mapping(address => uint256) public publisherReports;
    mapping(address => uint256) public advertiserReports;
    mapping(uint256 => mapping(address => bool)) private _hasReportedPage;
    mapping(uint256 => mapping(address => bool)) private _hasReportedAd;

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

    function setSettlementContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("settlement", settlementContract, addr);
        settlementContract = addr;
    }

    function setGovernanceContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("governance", governanceContract, addr);
        governanceContract = addr;
    }

    function setLifecycleContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", lifecycleContract, addr);
        lifecycleContract = addr;
    }

    function setPublishers(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("publishers", address(publishers), addr);
        publishers = IDatumPublishers(addr);
    }

    function setBudgetLedger(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), addr);
        budgetLedger = IDatumBudgetLedger(addr);
    }

    /// @notice Set challenge bonds contract. Pass address(0) to disable.
    function setChallengeBonds(address addr) external onlyOwner {
        emit ContractReferenceChanged("challengeBonds", address(challengeBonds), addr);
        challengeBonds = IDatumChallengeBonds(addr);
    }

    /// @notice Set the maximum campaign budget. 0 disables the cap.
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
    function setPublisherTags(bytes32[] calldata tagHashes) external {
        require(!pauseRegistry.paused(), "P");
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(msg.sender);
        require(pub.registered, "Not registered");
        require(tagHashes.length <= MAX_PUBLISHER_TAGS, "E65");

        // Clear old tags from the set
        bytes32[] storage oldTags = _publisherTags[msg.sender];
        for (uint256 i = 0; i < oldTags.length; i++) {
            _publisherTagSet[msg.sender][oldTags[i]] = false;
        }

        delete _publisherTags[msg.sender];
        bool enforce = enforceTagRegistry;
        for (uint256 i = 0; i < tagHashes.length; i++) {
            require(tagHashes[i] != bytes32(0), "E00");
            if (enforce) require(approvedTags[tagHashes[i]], "E81");
            _publisherTags[msg.sender].push(tagHashes[i]);
            _publisherTagSet[msg.sender][tagHashes[i]] = true;
        }

        emit TagsUpdated(msg.sender, tagHashes);
    }

    /// @notice Returns all tags for a publisher.
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    /// @notice Returns true if publisher has ALL of the required tags (AND logic).
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool) {
        if (requiredTags.length == 0) return true;
        require(requiredTags.length <= MAX_CAMPAIGN_TAGS, "E66");
        for (uint256 i = 0; i < requiredTags.length; i++) {
            if (!_publisherTagSet[publisher][requiredTags[i]]) return false;
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // Community reports (merged from DatumReports)
    // -------------------------------------------------------------------------

    /// @notice Report a campaign's page (publisher content violation).
    function reportPage(uint256 campaignId, uint8 reason) external {
        require(reason >= 1 && reason <= 5, "E68");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(!_hasReportedPage[campaignId][msg.sender], "E68");
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
                snapshot = DEFAULT_TAKE_RATE_BPS;
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

        emit CampaignCreated(campaignId, msg.sender, publisher, budgetValue, snapshot);
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function setMetadata(uint256 campaignId, bytes32 metadataHash) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        c.metadata = metadataHash;
        emit CampaignMetadataSet(campaignId, metadataHash);
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
