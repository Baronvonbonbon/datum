// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IDatumCampaigns.sol";

/// @title MockCampaigns
/// @notice Test double for DatumCampaigns — allows governance and settlement tests in isolation.
///         Includes inline publisher state for test setup (not from interface — publisher
///         management is now in DatumPublishers).
contract MockCampaigns is IDatumCampaigns {
    uint256 public nextCampaignId = 1;
    uint256 public minimumCpmFloor = 0;
    uint256 public pendingTimeoutBlocks = 100;
    address public settlementContract;
    address public governanceContract;

    mapping(uint256 => Campaign) private _campaigns;

    // Inline publisher state for test setup (mirrors DatumPublishers.Publisher)
    struct MockPublisher {
        uint16 takeRateBps;
        bool registered;
    }
    mapping(address => MockPublisher) private _publishers;

    // Calls recorded for assertion
    uint256 public lastActivated;
    uint256 public lastTerminated;
    uint256 public lastDeducted;
    uint256 public lastDeductAmount;

    function setSettlementContract(address s) external { settlementContract = s; }
    function setGovernanceContract(address g) external { governanceContract = g; }

    // -------------------------------------------------------------------------
    // Test helpers (not in interface)
    // -------------------------------------------------------------------------

    function setCampaign(
        uint256 id,
        address advertiser,
        address publisher,
        uint256 budget,
        uint256 dailyCap,
        uint256 bidCpm,
        uint16 takeRate,
        CampaignStatus status
    ) external {
        _campaigns[id] = Campaign({
            id: id,
            advertiser: advertiser,
            publisher: publisher,
            budgetPlanck: budget,
            remainingBudget: budget,
            dailyCapPlanck: dailyCap,
            bidCpmPlanck: bidCpm,
            dailySpent: 0,
            lastSpendDay: 0,
            pendingExpiryBlock: block.number + 1000,
            terminationBlock: 0,
            snapshotTakeRateBps: takeRate,
            status: status,
            version: 1
        });
        if (id >= nextCampaignId) nextCampaignId = id + 1;
    }

    function setRemainingBudget(uint256 campaignId, uint256 amount) external {
        _campaigns[campaignId].remainingBudget = amount;
    }

    function setStatus(uint256 campaignId, CampaignStatus status) external {
        _campaigns[campaignId].status = status;
    }

    /// @notice Inline publisher registration for test setup.
    ///         Not part of IDatumCampaigns — mirrors DatumPublishers for mock use.
    function registerPublisher(uint16 takeRateBps) external {
        _publishers[msg.sender] = MockPublisher({
            takeRateBps: takeRateBps,
            registered: true
        });
    }

    // -------------------------------------------------------------------------
    // IDatumCampaigns implementation
    // -------------------------------------------------------------------------

    function createCampaign(
        address publisher,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck
    ) external payable override returns (uint256 campaignId) {
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
            snapshotTakeRateBps: _publishers[publisher].takeRateBps,
            status: CampaignStatus.Pending,
            version: 1
        });
        emit CampaignCreated(campaignId, msg.sender, publisher, msg.value, dailyCapPlanck, bidCpmPlanck, _publishers[publisher].takeRateBps);
    }

    function activateCampaign(uint256 campaignId) external override {
        lastActivated = campaignId;
        _campaigns[campaignId].status = CampaignStatus.Active;
        emit CampaignActivated(campaignId);
    }

    function pauseCampaign(uint256 campaignId) external override {
        _campaigns[campaignId].status = CampaignStatus.Paused;
        emit CampaignPaused(campaignId);
    }

    function resumeCampaign(uint256 campaignId) external override {
        _campaigns[campaignId].status = CampaignStatus.Active;
        emit CampaignResumed(campaignId);
    }

    function completeCampaign(uint256 campaignId) external override {
        _campaigns[campaignId].status = CampaignStatus.Completed;
        emit CampaignCompleted(campaignId);
    }

    function terminateCampaign(uint256 campaignId) external override {
        lastTerminated = campaignId;
        Campaign storage c = _campaigns[campaignId];
        c.terminationBlock = block.number;
        uint256 slash = c.remainingBudget;
        c.remainingBudget = 0;
        c.status = CampaignStatus.Terminated;
        emit CampaignTerminated(campaignId, block.number);
        // Transfer slash amount to caller (governance)
        if (slash > 0) {
            payable(msg.sender).transfer(slash);
        }
    }

    function expirePendingCampaign(uint256 campaignId) external override {
        _campaigns[campaignId].status = CampaignStatus.Expired;
        emit CampaignExpired(campaignId);
    }

    function deductBudget(uint256 campaignId, uint256 amount) external override {
        lastDeducted = campaignId;
        lastDeductAmount = amount;
        Campaign storage c = _campaigns[campaignId];
        require(c.status == CampaignStatus.Active, "Not Active");
        require(amount <= c.remainingBudget, "Insufficient budget");

        uint256 today = block.timestamp / 86400;
        if (today != c.lastSpendDay) {
            c.dailySpent = 0;
            c.lastSpendDay = today;
        }
        require(c.dailySpent + amount <= c.dailyCapPlanck, "Daily cap exceeded");

        c.dailySpent += amount;
        c.remainingBudget -= amount;
        emit BudgetDeducted(campaignId, amount, c.remainingBudget);

        if (c.remainingBudget == 0) {
            c.status = CampaignStatus.Completed;
            emit CampaignCompleted(campaignId);
        }

        // Forward DOT to settlement contract (mirrors DatumCampaigns behavior)
        if (amount > 0) {
            payable(msg.sender).transfer(amount);
        }
    }

    function getCampaign(uint256 campaignId) external view override returns (Campaign memory) {
        return _campaigns[campaignId];
    }

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus) {
        return _campaigns[campaignId].status;
    }

    function getCampaignRemainingBudget(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].remainingBudget;
    }

    // Allow receiving DOT (for tests that fund mock campaigns)
    receive() external payable {}
}
