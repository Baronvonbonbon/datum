// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumCampaignValidator.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";

/// @title DatumCampaigns (Core)
/// @notice Campaign state management — creation, activation, pausing, metadata, views.
///
///         Alpha-3 multi-pricing: campaigns hold one or more action pots (view/click/
///         remote-action). Each pot has its own budget, daily cap, and rate, escrowed
///         in DatumBudgetLedger per (campaignId, actionType).
///
///         bidCpmPlanck is removed; use getCampaignViewBid() for the view pot rate,
///         or getCampaignPots() for the full pot list.
///
///         S2: Zero-address checks on all setters.
///         S3: ContractReferenceChanged events on wiring changes.
contract DatumCampaigns is IDatumCampaigns {
    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    bool private _locked;

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    modifier noReentrant() {
        require(!_locked, "E57");
        _locked = true;
        _;
        _locked = false;
    }

    /// @dev AUDIT-022: Minimum campaign budget to prevent dust campaigns (100 mDOT = 10^9 planck).
    uint256 public constant MINIMUM_BUDGET_PLANCK = 10**9;

    // Safe rollout: max campaign budget cap (0 = disabled)
    uint256 public maxCampaignBudget;

    uint256 public immutable minimumCpmFloor;
    uint256 public immutable pendingTimeoutBlocks;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public pauseRegistry;

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    address public settlementContract;
    address public governanceContract;
    address public lifecycleContract;
    IDatumCampaignValidator public campaignValidator;
    IDatumBudgetLedger public budgetLedger;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    uint256 public nextCampaignId;

    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => bytes32[]) private _campaignTags;

    // Snapshots from validateCreation — immutable record of publisher state at creation
    mapping(uint256 => address)   private _campaignRelaySigners;
    mapping(uint256 => bytes32[]) private _campaignPublisherTags;

    // ZK proof requirement — set at creation, immutable per campaign
    mapping(uint256 => bool) private _campaignRequiresZkProof;

    // Metadata hash — mutable by advertiser
    mapping(uint256 => bytes32) private _campaignMetadata;

    // Token reward — set at creation, immutable per campaign
    mapping(uint256 => address)  private _campaignRewardToken;
    mapping(uint256 => uint256)  private _campaignRewardPerImpression;

    // Action pots — set at creation, immutable per campaign
    // Up to 3 pots (actionType 0/1/2). _campaignPotCount tracks how many are configured.
    mapping(uint256 => ActionPotConfig[]) private _campaignPots;
    // Quick lookup for view pot rate (used by auction)
    mapping(uint256 => uint256) private _campaignViewBid;

    // FP-2: optional challenge bonds contract (address(0) = disabled)
    address public challengeBonds;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        uint256 _minimumCpmFloor,
        uint256 _pendingTimeoutBlocks,
        address _campaignValidator,
        address _pauseRegistry
    ) {
        require(_campaignValidator != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        owner = msg.sender;
        minimumCpmFloor = _minimumCpmFloor;
        pendingTimeoutBlocks = _pendingTimeoutBlocks;
        campaignValidator = IDatumCampaignValidator(_campaignValidator);
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

    function setCampaignValidator(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaignValidator", address(campaignValidator), addr);
        campaignValidator = IDatumCampaignValidator(addr);
    }

    function setBudgetLedger(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), addr);
        budgetLedger = IDatumBudgetLedger(addr);
    }

    /// @notice Set challenge bonds contract. Pass address(0) to disable.
    function setChallengeBonds(address addr) external onlyOwner {
        emit ContractReferenceChanged("challengeBonds", challengeBonds, addr);
        challengeBonds = addr;
    }

    /// @notice Set the maximum campaign budget. 0 disables the cap.
    function setMaxCampaignBudget(uint256 amount) external onlyOwner {
        maxCampaignBudget = amount;
        emit MaxCampaignBudgetSet(amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = pendingOwner;
        pendingOwner = address(0);
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
    ) external payable noReentrant returns (uint256 campaignId) {
        require(!pauseRegistry.paused(), "P");
        require(msg.value > bondAmount, "E11");
        uint256 budgetValue = msg.value - bondAmount;
        require(budgetValue >= MINIMUM_BUDGET_PLANCK, "E11"); // AUDIT-022: reject dust budgets
        require(maxCampaignBudget == 0 || budgetValue <= maxCampaignBudget, "E80");
        require(requiredTags.length <= 8, "E66");

        // Validate pots: 1–3 pots, no duplicate actionTypes, rates ≥ floor for view pots, budgets sum to budgetValue
        require(pots.length >= 1 && pots.length <= 3, "E93"); // E93: invalid pot count
        {
            bool[3] memory seen;
            uint256 totalPotBudget;
            for (uint256 i = 0; i < pots.length; i++) {
                require(pots[i].actionType <= 2, "E88"); // E88: invalid action type
                require(!seen[pots[i].actionType], "E93"); // E93: duplicate action type
                seen[pots[i].actionType] = true;
                require(pots[i].budgetPlanck > 0, "E11");
                require(pots[i].dailyCapPlanck > 0 && pots[i].dailyCapPlanck <= pots[i].budgetPlanck, "E12");
                require(pots[i].ratePlanck > 0, "E11");
                if (pots[i].actionType == 0) {
                    // View pot: rate is CPM — enforce minimum floor
                    require(pots[i].ratePlanck >= minimumCpmFloor, "E27");
                }
                totalPotBudget += pots[i].budgetPlanck;
            }
            require(totalPotBudget == budgetValue, "E11"); // pot budgets must sum exactly to budget
        }

        // SE-3: Delegate blocklist/allowlist/registration/tag checks to CampaignValidator
        (bool valid, uint16 snapshot, address snapRelaySigner, bytes32[] memory snapPubTags, bool allowlistWasEnabled) =
            campaignValidator.validateCreation(msg.sender, publisher, requiredTags);
        require(valid, "E62");
        campaignId = nextCampaignId++;

        // AUDIT-005: Store allowlist snapshot if publisher had allowlist enabled at creation
        if (allowlistWasEnabled) {
            campaignValidator.storeAllowlistSnapshot(campaignId, msg.sender, true);
        }

        _campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            publisher: publisher,
            pendingExpiryBlock: block.number + pendingTimeoutBlocks,
            terminationBlock: 0,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending
        });

        // Store required tags
        if (requiredTags.length > 0) {
            for (uint256 i = 0; i < requiredTags.length; i++) {
                _campaignTags[campaignId].push(requiredTags[i]);
            }
        }

        // Store publisher snapshots
        _campaignRelaySigners[campaignId] = snapRelaySigner;
        for (uint256 i = 0; i < snapPubTags.length; i++) {
            _campaignPublisherTags[campaignId].push(snapPubTags[i]);
        }

        if (requireZkProof) _campaignRequiresZkProof[campaignId] = true;

        if (rewardToken != address(0)) {
            require(rewardPerImpression > 0, "E11");
            _campaignRewardToken[campaignId] = rewardToken;
            _campaignRewardPerImpression[campaignId] = rewardPerImpression;
        }

        // Store pots and initialize budget per pot
        for (uint256 i = 0; i < pots.length; i++) {
            _campaignPots[campaignId].push(pots[i]);
            if (pots[i].actionType == 0) {
                _campaignViewBid[campaignId] = pots[i].ratePlanck;
            }
            budgetLedger.initializeBudget{value: pots[i].budgetPlanck}(
                campaignId, pots[i].actionType, pots[i].budgetPlanck, pots[i].dailyCapPlanck
            );
        }

        // FP-2: Lock optional bond in ChallengeBonds
        if (bondAmount > 0 && challengeBonds != address(0)) {
            (bool cbOk,) = challengeBonds.call{value: bondAmount}(
                abi.encodeWithSelector(bytes4(keccak256("lockBond(uint256,address,address)")),
                    campaignId, msg.sender, publisher)
            );
            require(cbOk, "E02");
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
        _campaignMetadata[campaignId] = metadataHash;
        emit CampaignMetadataSet(campaignId, metadataHash);
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
        return _campaignRelaySigners[campaignId];
    }

    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory) {
        return _campaignPublisherTags[campaignId];
    }

    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool) {
        return _campaignRequiresZkProof[campaignId];
    }

    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32) {
        return _campaignMetadata[campaignId];
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
        return _campaignViewBid[campaignId];
    }

    function getCampaignRewardToken(uint256 campaignId) external view returns (address) {
        return _campaignRewardToken[campaignId];
    }

    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256) {
        return _campaignRewardPerImpression[campaignId];
    }
}
