// SPDX-License-Identifier: Apache-2.0
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

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // Campaign creation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    function createCampaign(
        address publisher,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck,
        bytes32[] calldata requiredTags
    ) external payable noReentrant returns (uint256 campaignId) {
        require(!pauseRegistry.paused(), "P");
        require(msg.value > 0, "E11");
        require(bidCpmPlanck >= minimumCpmFloor, "E27");
        require(dailyCapPlanck > 0 && dailyCapPlanck <= msg.value, "E12");
        require(requiredTags.length <= 8, "E66");

        // SE-3: Delegate blocklist/allowlist/registration/tag checks to CampaignValidator
        (bool valid, uint16 snapshot) = campaignValidator.validateCreation(msg.sender, publisher, requiredTags);
        require(valid, "E62");
        campaignId = nextCampaignId++;

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

        // Escrow budget in BudgetLedger
        budgetLedger.initializeBudget{value: msg.value}(campaignId, msg.value, dailyCapPlanck);

        emit CampaignCreated(
            campaignId,
            msg.sender,
            publisher,
            msg.value,
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
        if (from == CampaignStatus.Active && to == CampaignStatus.Completed) return true;
        if (from == CampaignStatus.Active && to == CampaignStatus.Terminated) return true;
        if (from == CampaignStatus.Paused && to == CampaignStatus.Completed) return true;
        if (from == CampaignStatus.Pending && to == CampaignStatus.Expired) return true;
        return false;
    }

    /// @inheritdoc IDatumCampaigns
    function setTerminationBlock(uint256 campaignId, uint256 blockNum) external {
        require(msg.sender == lifecycleContract, "E25");
        _campaigns[campaignId].terminationBlock = blockNum;
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

    /// @dev Alpha-2: returns 4 values (no remainingBudget — now on BudgetLedger).
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    ) {
        Campaign storage c = _campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.bidCpmPlanck, c.snapshotTakeRateBps);
    }

}
