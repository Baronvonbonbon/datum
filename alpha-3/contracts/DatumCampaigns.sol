// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumCampaignValidator.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumBudgetLedger.sol";

/// @title DatumCampaigns (Core)
/// @notice Campaign state management — creation, activation, pausing, metadata, views.
///
///         Alpha-2 restructuring: budget fields extracted to DatumBudgetLedger,
///         lifecycle transitions (complete/terminate/expire) extracted to
///         DatumCampaignLifecycle. This contract is the canonical source of
///         campaign struct data and status.
///
///         Campaign struct reduced from 10 to 8 storage slots (budget fields removed).
///         Lifecycle contract updates status via setCampaignStatus() (gated).
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

    // Metadata hash — mutable by advertiser, stored for event-free retrieval (e.g. light clients)
    mapping(uint256 => bytes32) private _campaignMetadata;

    // Token reward — set at creation, immutable per campaign
    // rewardToken == address(0) means no token reward
    mapping(uint256 => address)  private _campaignRewardToken;
    mapping(uint256 => uint256) private _campaignRewardPerImpression;

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
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount
    ) external payable noReentrant returns (uint256 campaignId) {
        require(!pauseRegistry.paused(), "P");
        require(msg.value > bondAmount, "E11"); // msg.value must cover bond + at least some budget
        uint256 budgetValue = msg.value - bondAmount;
        require(budgetValue >= MINIMUM_BUDGET_PLANCK, "E11"); // AUDIT-022: reject dust budgets
        require(bidCpmPlanck >= minimumCpmFloor, "E27");
        require(dailyCapPlanck > 0 && dailyCapPlanck <= budgetValue, "E12");
        require(requiredTags.length <= 8, "E66");

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
            bidCpmPlanck: bidCpmPlanck,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending
        });

        // Store required tags in separate mapping (not in struct — PVM size)
        if (requiredTags.length > 0) {
            for (uint256 i = 0; i < requiredTags.length; i++) {
                _campaignTags[campaignId].push(requiredTags[i]);
            }
        }

        // Store publisher snapshots (relay signer + tag set at creation time)
        _campaignRelaySigners[campaignId] = snapRelaySigner;
        for (uint256 i = 0; i < snapPubTags.length; i++) {
            _campaignPublisherTags[campaignId].push(snapPubTags[i]);
        }

        // Store ZK proof requirement (immutable per campaign)
        if (requireZkProof) _campaignRequiresZkProof[campaignId] = true;

        // Store token reward config (immutable per campaign)
        if (rewardToken != address(0)) {
            require(rewardPerImpression > 0, "E11");
            _campaignRewardToken[campaignId] = rewardToken;
            _campaignRewardPerImpression[campaignId] = rewardPerImpression;
        }

        // Escrow budget in BudgetLedger (budget portion only)
        budgetLedger.initializeBudget{value: budgetValue}(campaignId, budgetValue, dailyCapPlanck);

        // FP-2: Lock optional bond in ChallengeBonds
        if (bondAmount > 0 && challengeBonds != address(0)) {
            (bool cbOk,) = challengeBonds.call{value: bondAmount}(
                abi.encodeWithSelector(bytes4(keccak256("lockBond(uint256,address,address)")),
                    campaignId, msg.sender, publisher)
            );
            require(cbOk, "E02");
        }

        emit CampaignCreated(
            campaignId,
            msg.sender,
            publisher,
            budgetValue,
            dailyCapPlanck,
            bidCpmPlanck,
            snapshot
        );
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
    // Governance activation (unchanged)
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
    // Advertiser pause/resume (unchanged)
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
        // SM-7: Validate status transitions
        CampaignStatus current = _campaigns[campaignId].status;
        require(_validTransition(current, newStatus), "E67");
        _campaigns[campaignId].status = newStatus;
    }

    function _validTransition(CampaignStatus from, CampaignStatus to) internal pure returns (bool) {
        if (from == CampaignStatus.Active  && to == CampaignStatus.Completed)  return true;
        if (from == CampaignStatus.Active  && to == CampaignStatus.Terminated) return true;
        if (from == CampaignStatus.Active  && to == CampaignStatus.Pending)    return true; // governance demotion
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Completed)  return true;
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Terminated) return true;
        if (from == CampaignStatus.Paused  && to == CampaignStatus.Pending)    return true; // governance demotion
        if (from == CampaignStatus.Pending && to == CampaignStatus.Expired)    return true;
        if (from == CampaignStatus.Pending && to == CampaignStatus.Terminated) return true; // demoted + nay wins
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

    /// @dev Alpha-2: returns 4 values (no remainingBudget — now on BudgetLedger).
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    ) {
        Campaign storage c = _campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.bidCpmPlanck, c.snapshotTakeRateBps);
    }

    function getCampaignRewardToken(uint256 campaignId) external view returns (address) {
        return _campaignRewardToken[campaignId];
    }

    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256) {
        return _campaignRewardPerImpression[campaignId];
    }

}
