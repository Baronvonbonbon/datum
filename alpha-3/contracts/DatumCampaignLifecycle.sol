// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumCampaignLifecycle
/// @notice Handles campaign lifecycle transitions: complete, terminate, expire.
///         Extracted from DatumCampaigns (alpha) to free PVM bytecode headroom.
///
///         Reads campaign state from DatumCampaigns, routes refunds through
///         DatumBudgetLedger, and calls back to Campaigns to update status.
///
///         Termination: 10% slash to governance, 90% refund to advertiser.
///         Completion/Expiry: full remaining budget refund to advertiser.
contract DatumCampaignLifecycle is IDatumCampaignLifecycle, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // References
    // -------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    IDatumCampaigns public campaigns;
    IDatumBudgetLedger public budgetLedger;
    IDatumPauseRegistry public pauseRegistry;
    address public governanceContract;
    address public settlementContract;
    // FP-2: optional challenge bonds contract (address(0) = disabled)
    address public challengeBonds;

    /// @dev P20: Blocks of inactivity before a campaign can be expired.
    ///      30 days at 6s blocks = 432,000 blocks.
    uint256 public immutable inactivityTimeoutBlocks;

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.paused(), "P");
        _;
    }

    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _pauseRegistry, uint256 _inactivityTimeoutBlocks) {
        require(_pauseRegistry != address(0), "E00");
        require(_inactivityTimeoutBlocks > 0, "E00");
        owner = msg.sender;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        inactivityTimeoutBlocks = _inactivityTimeoutBlocks;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaigns", address(campaigns), addr);
        campaigns = IDatumCampaigns(addr);
    }

    function setBudgetLedger(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), addr);
        budgetLedger = IDatumBudgetLedger(addr);
    }

    function setGovernanceContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("governance", governanceContract, addr);
        governanceContract = addr;
    }

    function setSettlementContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("settlement", settlementContract, addr);
        settlementContract = addr;
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
    // Lifecycle transitions
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaignLifecycle
    /// @dev Advertiser or settlement (auto-complete) can call.
    ///      Drains remaining budget to advertiser via BudgetLedger.
    function completeCampaign(uint256 campaignId) external nonReentrant {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");
        require(
            msg.sender == advertiser || msg.sender == settlementContract,
            "E13"
        );

        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaigns.CampaignStatus.Active ||
            status == IDatumCampaigns.CampaignStatus.Paused,
            "E14"
        );

        // Update status on Campaigns
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Completed);

        // Drain remaining budget to advertiser
        budgetLedger.drainToAdvertiser(campaignId, advertiser);

        // FP-2: Return bond if set (non-critical — silently skip on failure)
        if (challengeBonds != address(0)) {
            challengeBonds.call(
                abi.encodeWithSelector(bytes4(keccak256("returnBond(uint256)")), campaignId)
            );
        }

        emit CampaignCompleted(campaignId);
    }

    /// @inheritdoc IDatumCampaignLifecycle
    /// @dev Called by GovernanceV2 directly (not via Campaigns).
    ///      10% slash to governance, 90% refund to advertiser.
    function terminateCampaign(uint256 campaignId) external nonReentrant {
        require(!pauseRegistry.paused(), "P");
        require(msg.sender == governanceContract, "E19");

        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");

        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaigns.CampaignStatus.Active  ||
            status == IDatumCampaigns.CampaignStatus.Paused  ||
            status == IDatumCampaigns.CampaignStatus.Pending, // demoted campaigns
            "E14"
        );

        // Record termination block + update status on Campaigns
        campaigns.setTerminationBlock(campaignId, block.number);
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Terminated);

        // 10% slash to governance
        budgetLedger.drainFraction(campaignId, governanceContract, 1000);

        // 90% remaining refund to advertiser
        budgetLedger.drainToAdvertiser(campaignId, advertiser);

        emit CampaignTerminated(campaignId, block.number);
    }

    /// @inheritdoc IDatumCampaignLifecycle
    /// @dev Callable by anyone once pendingExpiryBlock has passed.
    function expirePendingCampaign(uint256 campaignId) external nonReentrant {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");

        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(status == IDatumCampaigns.CampaignStatus.Pending, "E20");

        uint256 expiryBlock = campaigns.getPendingExpiryBlock(campaignId);
        require(block.number > expiryBlock, "E24");

        // Update status on Campaigns
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Expired);

        // Full refund to advertiser
        budgetLedger.drainToAdvertiser(campaignId, advertiser);

        // FP-2: Return bond if set (non-critical)
        if (challengeBonds != address(0)) {
            challengeBonds.call(
                abi.encodeWithSelector(bytes4(keccak256("returnBond(uint256)")), campaignId)
            );
        }

        emit CampaignExpired(campaignId);
    }

    /// @inheritdoc IDatumCampaignLifecycle
    /// @dev Called by GovernanceV2 when nay reaches 50% on an Active/Paused campaign.
    ///      No budget is drained — the campaign returns to Pending for a second evaluation.
    ///      pendingExpiryBlock is set to type(uint256).max to prevent expirePendingCampaign
    ///      from racing the governance termination path.
    function demoteCampaign(uint256 campaignId) external nonReentrant {
        require(!pauseRegistry.paused(), "P");
        require(msg.sender == governanceContract, "E19");

        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaigns.CampaignStatus.Active ||
            status == IDatumCampaigns.CampaignStatus.Paused,
            "E14"
        );

        // Block expirePendingCampaign from firing — governance will terminate via evaluateCampaign
        campaigns.setPendingExpiryBlock(campaignId, type(uint256).max);
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Pending);

        emit CampaignDemoted(campaignId);
    }

    // -------------------------------------------------------------------------
    // P20: Inactivity timeout
    // -------------------------------------------------------------------------

    /// @notice Expire an Active/Paused campaign that has had no settlement activity
    ///         for `inactivityTimeoutBlocks`. Permissionless — anyone can call.
    ///         Full remaining budget refunded to advertiser.
    function expireInactiveCampaign(uint256 campaignId) external nonReentrant whenNotPaused {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");

        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaigns.CampaignStatus.Active ||
            status == IDatumCampaigns.CampaignStatus.Paused,
            "E14"
        );

        uint256 lastBlock = budgetLedger.lastSettlementBlock(campaignId);
        require(block.number > lastBlock + inactivityTimeoutBlocks, "E64");

        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Completed);
        budgetLedger.drainToAdvertiser(campaignId, advertiser);

        // FP-2: Return bond if set (non-critical)
        if (challengeBonds != address(0)) {
            challengeBonds.call(
                abi.encodeWithSelector(bytes4(keccak256("returnBond(uint256)")), campaignId)
            );
        }

        emit CampaignCompleted(campaignId);
    }
}
