// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockCampaigns
/// @notice Test-only mock for DatumCampaigns. Supports direct status/data manipulation
///         for isolated governance, settlement, and lifecycle tests.
///
///         Alpha-2: getCampaignForSettlement returns 4 values (no remainingBudget).
///         Supports setCampaignStatus/setTerminationBlock for lifecycle integration.
contract MockCampaigns {
    enum CampaignStatus { Pending, Active, Paused, Completed, Terminated, Expired }

    struct MockCampaign {
        address advertiser;
        address publisher;
        uint256 bidCpmPlanck;
        uint16 snapshotTakeRateBps;
        CampaignStatus status;
        uint256 pendingExpiryBlock;
        uint256 terminationBlock;
    }

    mapping(uint256 => MockCampaign) public campaigns;

    address public settlementContract;
    address public governanceContract;
    address public lifecycleContract;
    address public budgetLedger;

    uint256 public nextCampaignId = 1;

    // -------------------------------------------------------------------------
    // Test setup helpers
    // -------------------------------------------------------------------------

    function setCampaign(
        uint256 id,
        address advertiser,
        address publisher,
        uint256 bidCpmPlanck,
        uint16 takeRate,
        uint8 status
    ) external {
        campaigns[id] = MockCampaign({
            advertiser: advertiser,
            publisher: publisher,
            bidCpmPlanck: bidCpmPlanck,
            snapshotTakeRateBps: takeRate,
            status: CampaignStatus(status),
            pendingExpiryBlock: block.number + 100,
            terminationBlock: 0
        });
        if (id >= nextCampaignId) {
            nextCampaignId = id + 1;
        }
    }

    function setStatus(uint256 id, uint8 status) external {
        campaigns[id].status = CampaignStatus(status);
    }

    function setSettlementContract(address addr) external {
        settlementContract = addr;
    }

    function setGovernanceContract(address addr) external {
        governanceContract = addr;
    }

    function setLifecycleContract(address addr) external {
        lifecycleContract = addr;
    }

    function setBudgetLedger(address addr) external {
        budgetLedger = addr;
    }

    /// @dev Test helper: forwards initializeBudget to BudgetLedger.
    ///      MockCampaigns is set as budgetLedger.campaigns, so this call is authorized.
    function initBudget(uint256 campaignId, uint256 budget, uint256 dailyCap) external payable {
        require(msg.value == budget, "E16");
        (bool ok,) = budgetLedger.call{value: budget}(
            abi.encodeWithSignature("initializeBudget(uint256,uint256,uint256)", campaignId, budget, dailyCap)
        );
        require(ok, "E02");
    }

    // -------------------------------------------------------------------------
    // IDatumCampaigns interface (subset used by other contracts)
    // -------------------------------------------------------------------------

    /// @dev 4-value return matching alpha-2 interface (no remainingBudget).
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    ) {
        MockCampaign storage c = campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.bidCpmPlanck, c.snapshotTakeRateBps);
    }

    function activateCampaign(uint256 campaignId) external {
        require(
            msg.sender == governanceContract,
            "E19"
        );
        campaigns[campaignId].status = CampaignStatus.Active;
    }

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus) {
        return campaigns[campaignId].status;
    }

    function getCampaignAdvertiser(uint256 campaignId) external view returns (address) {
        return campaigns[campaignId].advertiser;
    }

    function getCampaignPublisher(uint256 campaignId) external view returns (address) {
        return campaigns[campaignId].publisher;
    }

    function getPendingExpiryBlock(uint256 campaignId) external view returns (uint256) {
        return campaigns[campaignId].pendingExpiryBlock;
    }

    /// @dev Called by Lifecycle contract to update status.
    function setCampaignStatus(uint256 campaignId, CampaignStatus newStatus) external {
        require(msg.sender == lifecycleContract, "E25");
        campaigns[campaignId].status = newStatus;
    }

    /// @dev Called by Lifecycle contract to record termination block.
    function setTerminationBlock(uint256 campaignId, uint256 blockNum) external {
        require(msg.sender == lifecycleContract, "E25");
        campaigns[campaignId].terminationBlock = blockNum;
    }

    receive() external payable {}
}
