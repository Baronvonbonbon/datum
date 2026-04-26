// SPDX-License-Identifier: GPL-3.0-or-later
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

    struct ActionPotConfig {
        uint8 actionType;
        uint256 budgetPlanck;
        uint256 dailyCapPlanck;
        uint256 ratePlanck;
        address actionVerifier;
    }

    // Per-campaign per-actionType pot rates (set on initBudget, or manually)
    mapping(uint256 => mapping(uint8 => uint256)) public campaignPotRate;

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
    function initBudget(uint256 campaignId, uint8 actionType, uint256 budget, uint256 dailyCap) external payable {
        require(msg.value == budget, "E16");
        // Store pot rate from campaign config for getCampaignPot
        campaignPotRate[campaignId][actionType] = campaigns[campaignId].bidCpmPlanck;
        (bool ok,) = budgetLedger.call{value: budget}(
            abi.encodeWithSignature("initializeBudget(uint256,uint8,uint256,uint256)", campaignId, actionType, budget, dailyCap)
        );
        require(ok, "E02");
    }

    /// @dev Returns ActionPotConfig for ClaimValidator rate check.
    function getCampaignPot(uint256 campaignId, uint8 actionType) external view returns (ActionPotConfig memory) {
        return ActionPotConfig({
            actionType: actionType,
            budgetPlanck: 0,
            dailyCapPlanck: 0,
            ratePlanck: campaignPotRate[campaignId][actionType],
            actionVerifier: address(0)
        });
    }

    // -------------------------------------------------------------------------
    // IDatumCampaigns interface (subset used by other contracts)
    // -------------------------------------------------------------------------

    /// @dev 3-value return matching alpha-3 IDatumCampaignsMinimal interface.
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint16 snapshotTakeRateBps
    ) {
        MockCampaign storage c = campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.snapshotTakeRateBps);
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

    /// @dev Called by Lifecycle contract to override pendingExpiryBlock (e.g. on demotion).
    function setPendingExpiryBlock(uint256 campaignId, uint256 blockNum) external {
        require(msg.sender == lifecycleContract, "E25");
        campaigns[campaignId].pendingExpiryBlock = blockNum;
    }

    // -------------------------------------------------------------------------
    // IDatumPublishers stubs (used as publishers placeholder in settlement tests)
    // -------------------------------------------------------------------------

    // Blocklist mapping for tests that need to simulate blocks
    mapping(address => bool) public blockedAddresses;

    function blockAddress(address addr) external {
        blockedAddresses[addr] = true;
    }

    function unblockAddress(address addr) external {
        blockedAddresses[addr] = false;
    }

    /// @dev Returns false by default — no publisher is blocked unless explicitly set.
    function isBlocked(address addr) external view returns (bool) {
        return blockedAddresses[addr];
    }

    /// @dev Returns false by default — no allowlist enabled.
    function allowlistEnabled(address) external pure returns (bool) {
        return false;
    }

    /// @dev Per-publisher relay signer (mirrors DatumPublishers.relaySigner mapping).
    mapping(address => address) public relaySigner;

    function setRelaySigner(address pub, address relay) external {
        relaySigner[pub] = relay;
    }

    // -------------------------------------------------------------------------
    // IDatumCampaignsSettlement stubs (used for ZK proof check in ClaimValidator)
    // -------------------------------------------------------------------------

    mapping(uint256 => bool) public campaignRequiresZkProof;

    function setCampaignRequiresZkProof(uint256 campaignId, bool required) external {
        campaignRequiresZkProof[campaignId] = required;
    }

    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool) {
        return campaignRequiresZkProof[campaignId];
    }

    receive() external payable {}
}
