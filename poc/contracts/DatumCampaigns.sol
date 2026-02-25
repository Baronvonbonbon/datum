// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";

/// @title DatumCampaigns
/// @notice Manages campaign lifecycle: creation, activation, pausing, termination, expiry.
///
/// Key design decisions (fixes applied vs. PoC spec):
///   - Issue 5: Publisher take rate snapshotted at createCampaign(); settlement reads snapshot.
///   - Issue 8: pendingExpiryBlock set at creation; expirePendingCampaign() callable by anyone.
///   - Issue 4: ReentrancyGuard on all state-mutating functions.
///   - Publisher management extracted to DatumPublishers for PVM bytecode size limits.
///   - Only governance can activate/terminate; only settlement can deductBudget.
///   - Pausable removed (PVM size); emergency pause achieved by renouncing governance/settlement.
contract DatumCampaigns is IDatumCampaigns, ReentrancyGuard, Ownable {
    // -------------------------------------------------------------------------
    // Configuration (governance-settable in full build; constructor-set in PoC)
    // -------------------------------------------------------------------------

    uint256 public minimumCpmFloor;          // Minimum allowed bidCpmPlanck
    uint256 public pendingTimeoutBlocks;     // Blocks before Pending → Expired allowed

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    address public settlementContract;
    address public governanceContract;
    IDatumPublishers public publishers;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    uint256 public nextCampaignId;

    mapping(uint256 => Campaign) private _campaigns;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        uint256 _minimumCpmFloor,
        uint256 _pendingTimeoutBlocks,
        address _publishers
    ) Ownable(msg.sender) {
        require(_publishers != address(0), "E00");
        minimumCpmFloor = _minimumCpmFloor;
        pendingTimeoutBlocks = _pendingTimeoutBlocks;
        publishers = IDatumPublishers(_publishers);
        nextCampaignId = 1;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSettlementContract(address _settlement) external onlyOwner {
        require(_settlement != address(0), "E00");
        settlementContract = _settlement;
    }

    function setGovernanceContract(address _governance) external onlyOwner {
        require(_governance != address(0), "E00");
        governanceContract = _governance;
    }

    function setMinimumCpmFloor(uint256 _floor) external onlyOwner {
        minimumCpmFloor = _floor;
    }

    function setPendingTimeoutBlocks(uint256 _blocks) external onlyOwner {
        pendingTimeoutBlocks = _blocks;
    }

    // -------------------------------------------------------------------------
    // Campaign lifecycle
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @dev Issue 5 fix: snapshotTakeRateBps copied from publisher at creation.
    ///      Issue 8 fix: pendingExpiryBlock = block.number + pendingTimeoutBlocks.
    function createCampaign(
        address publisher,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck
    ) external payable nonReentrant returns (uint256 campaignId) {
        require(msg.value > 0, "E11");
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
        require(pub.registered, "E17");
        require(bidCpmPlanck >= minimumCpmFloor, "Bid below minimum CPM floor"); // keep: tested by name
        require(dailyCapPlanck > 0 && dailyCapPlanck <= msg.value, "E12");

        uint16 snapshot = pub.takeRateBps;
        campaignId = nextCampaignId++;

        _campaigns[campaignId] = Campaign({
            id: campaignId,
            advertiser: msg.sender,
            publisher: publisher,
            budgetPlanck: msg.value,
            remainingBudget: msg.value,
            dailyCapPlanck: dailyCapPlanck,
            bidCpmPlanck: bidCpmPlanck,
            dailySpent: 0,
            lastSpendDay: 0,
            pendingExpiryBlock: block.number + pendingTimeoutBlocks,
            terminationBlock: 0,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending,
            version: 1
        });

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

    /// @inheritdoc IDatumCampaigns
    function activateCampaign(uint256 campaignId) external nonReentrant {
        require(msg.sender == governanceContract, "Governance only");
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(c.status == CampaignStatus.Pending, "Not Pending");

        c.status = CampaignStatus.Active;
        emit CampaignActivated(campaignId);
    }

    /// @inheritdoc IDatumCampaigns
    function pauseCampaign(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(msg.sender == c.advertiser, "Advertiser only");
        require(c.status == CampaignStatus.Active, "Not Active");

        c.status = CampaignStatus.Paused;
        emit CampaignPaused(campaignId);
    }

    /// @inheritdoc IDatumCampaigns
    function resumeCampaign(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(msg.sender == c.advertiser, "Advertiser only");
        require(c.status == CampaignStatus.Paused, "Not Paused");

        c.status = CampaignStatus.Active;
        emit CampaignResumed(campaignId);
    }

    /// @inheritdoc IDatumCampaigns
    function completeCampaign(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(
            msg.sender == c.advertiser || msg.sender == settlementContract,
            "E13"
        );
        require(
            c.status == CampaignStatus.Active || c.status == CampaignStatus.Paused,
            "E14"
        );

        // Return any remaining budget to advertiser
        uint256 refund = c.remainingBudget;
        c.remainingBudget = 0;
        c.status = CampaignStatus.Completed;

        if (refund > 0) {
            (bool ok,) = c.advertiser.call{value: refund}("");
            require(ok, "E02");
        }

        emit CampaignCompleted(campaignId);
    }

    /// @inheritdoc IDatumCampaigns
    /// @dev Issue 4 fix: terminationBlock recorded; governance slashes escrow via separate mechanism.
    function terminateCampaign(uint256 campaignId) external nonReentrant {
        require(msg.sender == governanceContract, "Governance only");
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(
            c.status == CampaignStatus.Active || c.status == CampaignStatus.Paused,
            "E14"
        );

        c.terminationBlock = block.number;
        c.status = CampaignStatus.Terminated;

        // Transfer remaining escrow to governance for slash distribution
        uint256 slashAmount = c.remainingBudget;
        c.remainingBudget = 0;

        emit CampaignTerminated(campaignId, block.number);

        if (slashAmount > 0) {
            (bool ok,) = governanceContract.call{value: slashAmount}("");
            require(ok, "E02");
        }
    }

    /// @inheritdoc IDatumCampaigns
    /// @dev Issue 8 fix: callable by anyone once pendingExpiryBlock has passed.
    function expirePendingCampaign(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(c.status == CampaignStatus.Pending, "Not Pending");
        require(block.number > c.pendingExpiryBlock, "Expiry block not reached");

        address advertiser = c.advertiser;
        uint256 refund = c.remainingBudget;
        c.remainingBudget = 0;
        c.status = CampaignStatus.Expired;

        emit CampaignExpired(campaignId);

        if (refund > 0) {
            (bool ok,) = advertiser.call{value: refund}("");
            require(ok, "E02");
        }
    }

    // -------------------------------------------------------------------------
    // Budget management
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @dev Daily cap uses block.timestamp / 86400 as the day index.
    ///      Note: timestamp manipulation is an accepted PoC risk.
    function deductBudget(uint256 campaignId, uint256 amount) external nonReentrant {
        require(msg.sender == settlementContract, "Settlement only");
        Campaign storage c = _campaigns[campaignId];
        require(c.id != 0, "E01");
        require(c.status == CampaignStatus.Active, "E15");
        require(amount <= c.remainingBudget, "E16");

        // Reset daily cap on new day
        uint256 today = block.timestamp / 86400;
        if (today != c.lastSpendDay) {
            c.dailySpent = 0;
            c.lastSpendDay = today;
        }

        require(c.dailySpent + amount <= c.dailyCapPlanck, "Daily cap exceeded"); // keep: tested by name

        c.dailySpent += amount;
        c.remainingBudget -= amount;

        emit BudgetDeducted(campaignId, amount, c.remainingBudget);

        // Auto-complete if budget exhausted
        if (c.remainingBudget == 0) {
            c.status = CampaignStatus.Completed;
            emit CampaignCompleted(campaignId);
        }

        // Forward payment DOT to settlement contract for pull-payment distribution
        (bool ok,) = settlementContract.call{value: amount}("");
        require(ok, "E02");
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        return _campaigns[campaignId];
    }

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus) {
        return _campaigns[campaignId].status;
    }

    function getCampaignRemainingBudget(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].remainingBudget;
    }
}
