// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumActivationBonds.sol";

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
    address public activationBonds;
    IDatumBudgetLedger public budgetLedger;

    uint256 public nextCampaignId = 1;

    // -------------------------------------------------------------------------
    // Test setup helpers
    // -------------------------------------------------------------------------

    /// @dev Test helper: also auto-populates the multi-publisher allowlist
    ///      with `publisher` (if non-zero) so the new ClaimValidator
    ///      Check 3 allowlist path resolves for closed-campaign test setups.
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
        // Multi-publisher unification: closed campaign = allowlist with one entry.
        if (publisher != address(0)) {
            _allowedPublisher[id][publisher] = true;
            _allowedPublisherTakeRate[id][publisher] = takeRate;
            _allowedPublisherCount[id] = 1;
        } else {
            _allowedPublisherCount[id] = 0;
        }
        if (id >= nextCampaignId) {
            nextCampaignId = id + 1;
        }
    }

    /// @dev Add a publisher to the campaign's allowlist (multi-publisher).
    function addAllowedPublisherMock(uint256 id, address publisher, uint16 takeRate) external {
        require(publisher != address(0), "E00");
        require(!_allowedPublisher[id][publisher], "E71");
        _allowedPublisher[id][publisher] = true;
        _allowedPublisherTakeRate[id][publisher] = takeRate;
        _allowedPublisherCount[id] += 1;
    }

    /// @dev Remove a publisher from the campaign's allowlist.
    function removeAllowedPublisherMock(uint256 id, address publisher) external {
        require(_allowedPublisher[id][publisher], "E01");
        _allowedPublisher[id][publisher] = false;
        _allowedPublisherCount[id] -= 1;
    }

    // Multi-publisher mock state.
    mapping(uint256 => mapping(address => bool)) private _allowedPublisher;
    mapping(uint256 => mapping(address => uint16)) private _allowedPublisherTakeRate;
    mapping(uint256 => uint16) private _allowedPublisherCount;

    function isAllowedPublisher(uint256 campaignId, address publisher) external view returns (bool) {
        return _allowedPublisher[campaignId][publisher];
    }
    function getCampaignPublisherTakeRate(uint256 campaignId, address publisher) external view returns (uint16) {
        return _allowedPublisherTakeRate[campaignId][publisher];
    }
    function campaignAllowedPublisherCount(uint256 campaignId) external view returns (uint16) {
        return _allowedPublisherCount[campaignId];
    }
    function campaignMode(uint256 campaignId) external view returns (uint8) {
        return _allowedPublisherCount[campaignId] > 0 ? 1 : 0;
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
        budgetLedger = IDatumBudgetLedger(addr);
    }

    /// @dev Test helper: forwards initializeBudget to BudgetLedger.
    ///      MockCampaigns is set as budgetLedger.campaigns, so this call is authorized.
    function initBudget(uint256 campaignId, uint8 actionType, uint256 budget, uint256 dailyCap) external payable {
        require(msg.value == budget, "E16");
        // Store pot rate from campaign config for getCampaignPot
        campaignPotRate[campaignId][actionType] = campaigns[campaignId].bidCpmPlanck;
        budgetLedger.initializeBudget{value: budget}(campaignId, actionType, budget, dailyCap);
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
            msg.sender == governanceContract ||
            (activationBonds != address(0) && msg.sender == activationBonds),
            "E19"
        );
        campaigns[campaignId].status = CampaignStatus.Active;
    }

    function setActivationBonds(address addr) external {
        activationBonds = addr;
    }

    /// @notice Test helper: forwards an openBond call as the campaigns contract.
    function callOpenBond(uint256 campaignId, address creator) external payable {
        require(activationBonds != address(0), "E00");
        IDatumActivationBonds(activationBonds).openBond{value: msg.value}(campaignId, creator);
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

    /// @dev H-3: strict variant. Mock has no curator so behavior matches isBlocked.
    ///      `revertOnIsBlockedStrict` lets tests simulate a misconfigured /
    ///      reverting curator so the fail-closed branch in Settlement is reachable.
    bool public revertOnIsBlockedStrict;
    function setRevertOnIsBlockedStrict(bool v) external { revertOnIsBlockedStrict = v; }
    function isBlockedStrict(address addr) external view returns (bool) {
        require(!revertOnIsBlockedStrict, "curator-down");
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

    /// @dev M6: per-advertiser relay signer (mirrors DatumCampaigns.advertiserRelaySigner mapping).
    mapping(address => address) public advertiserRelaySigner;

    function setAdvertiserRelaySigner(address adv, address relay) external {
        advertiserRelaySigner[adv] = relay;
    }

    function getAdvertiserRelaySigner(address advertiser) external view returns (address) {
        return advertiserRelaySigner[advertiser];
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

    // ── A3: AssuranceLevel mirror ────────────────────────────────────────────
    mapping(uint256 => uint8) public campaignAssuranceLevel;
    function setCampaignAssuranceLevel(uint256 campaignId, uint8 level) external {
        require(level <= 2, "E11");
        campaignAssuranceLevel[campaignId] = level;
    }
    function getCampaignAssuranceLevel(uint256 campaignId) external view returns (uint8) {
        return campaignAssuranceLevel[campaignId];
    }

    receive() external payable {}
}
