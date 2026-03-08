// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumCampaigns
/// @notice Manages campaign lifecycle: creation, activation, pausing, termination, expiry.
///
/// Key design decisions (fixes applied vs. PoC spec):
///   - Issue 5: Publisher take rate snapshotted at createCampaign(); settlement reads snapshot.
///   - Issue 8: pendingExpiryBlock set at creation; expirePendingCampaign() callable by anyone.
///   - Issue 4: ReentrancyGuard on all state-mutating functions.
///   - Publisher management extracted to DatumPublishers for PVM bytecode size limits.
///   - Only governance can activate/terminate; only settlement can deductBudget.
///   - A1.1: Global pause via DatumPauseRegistry staticcall.
///   - A1.2: 48-hour timelock via external DatumTimelock contract (ownership transferred post-deploy).
contract DatumCampaigns is IDatumCampaigns {
    // -------------------------------------------------------------------------
    // Configuration (governance-settable in full build; constructor-set in PoC)
    // -------------------------------------------------------------------------

    address public owner;
    bool private _locked;

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    uint256 public immutable minimumCpmFloor;         // Minimum allowed bidCpmPlanck
    uint256 public immutable pendingTimeoutBlocks;    // Blocks before Pending → Expired allowed

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public pauseRegistry;

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
        address _publishers,
        address _pauseRegistry
    ) {
        owner = msg.sender;
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        minimumCpmFloor = _minimumCpmFloor;
        pendingTimeoutBlocks = _pendingTimeoutBlocks;
        publishers = IDatumPublishers(_publishers);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        nextCampaignId = 1;
    }

    // -------------------------------------------------------------------------
    // Admin — contract reference setters (protected by external DatumTimelock)
    // -------------------------------------------------------------------------

    function setSettlementContract(address addr) external onlyOwner {
        settlementContract = addr;
    }

    function setGovernanceContract(address addr) external onlyOwner {
        governanceContract = addr;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        owner = newOwner;
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
        uint256 bidCpmPlanck,
        uint8 categoryId
    ) external payable returns (uint256 campaignId) {
        require(!pauseRegistry.paused(), "P");
        require(msg.value > 0, "E11");
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
        require(pub.registered, "E17");
        require(bidCpmPlanck >= minimumCpmFloor, "E27");
        require(dailyCapPlanck > 0 && dailyCapPlanck <= msg.value, "E12");

        uint16 snapshot = pub.takeRateBps;
        campaignId = nextCampaignId++;

        _campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            publisher: publisher,
            remainingBudget: msg.value,
            dailyCapPlanck: dailyCapPlanck,
            bidCpmPlanck: bidCpmPlanck,
            dailySpent: 0,
            lastSpendDay: 0,
            pendingExpiryBlock: block.number + pendingTimeoutBlocks,
            terminationBlock: 0,
            snapshotTakeRateBps: snapshot,
            status: CampaignStatus.Pending,
            categoryId: categoryId
        });

        emit CampaignCreated(
            campaignId,
            msg.sender,
            publisher,
            msg.value,
            dailyCapPlanck,
            bidCpmPlanck,
            snapshot,
            categoryId
        );
    }

    /// @inheritdoc IDatumCampaigns
    function setMetadata(uint256 campaignId, bytes32 metadataHash) external {
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(msg.sender == c.advertiser, "E21");
        emit CampaignMetadataSet(campaignId, metadataHash);
    }

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

    /// @inheritdoc IDatumCampaigns
    /// @dev pause=true: Active→Paused, pause=false: Paused→Active. Merged to reduce PVM size.
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

    /// @inheritdoc IDatumCampaigns
    function completeCampaign(uint256 campaignId) external {
        require(!_locked, "E57"); _locked = true;
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
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

        emit CampaignCompleted(campaignId);

        if (refund > 0) {
            _send(c.advertiser, refund);
        }
        _locked = false;
    }

    /// @inheritdoc IDatumCampaigns
    /// @dev Issue 4 fix: terminationBlock recorded; governance slashes escrow via separate mechanism.
    function terminateCampaign(uint256 campaignId) external {
        require(!_locked, "E57"); _locked = true;
        require(!pauseRegistry.paused(), "P");
        require(msg.sender == governanceContract, "E19");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(
            c.status == CampaignStatus.Active || c.status == CampaignStatus.Paused,
            "E14"
        );

        c.terminationBlock = block.number;
        c.status = CampaignStatus.Terminated;

        uint256 remaining = c.remainingBudget;
        c.remainingBudget = 0;

        // 10% slash to governance for nay voter rewards; 90% refund to advertiser
        uint256 slashAmount = remaining / 10;
        uint256 refund = remaining - slashAmount;

        emit CampaignTerminated(campaignId, block.number);

        if (slashAmount > 0) {
            _send(governanceContract, slashAmount);
        }
        if (refund > 0) {
            _send(c.advertiser, refund);
        }
        _locked = false;
    }

    /// @inheritdoc IDatumCampaigns
    /// @dev Issue 8 fix: callable by anyone once pendingExpiryBlock has passed.
    function expirePendingCampaign(uint256 campaignId) external {
        require(!_locked, "E57"); _locked = true;
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(c.status == CampaignStatus.Pending, "E20");
        require(block.number > c.pendingExpiryBlock, "E24");

        address advertiser = c.advertiser;
        uint256 refund = c.remainingBudget;
        c.remainingBudget = 0;
        c.status = CampaignStatus.Expired;

        emit CampaignExpired(campaignId);

        if (refund > 0) {
            _send(advertiser, refund);
        }
        _locked = false;
    }

    // -------------------------------------------------------------------------
    // Budget management
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaigns
    /// @dev Daily cap uses block.timestamp / 86400 as the day index.
    ///      Note: timestamp manipulation is an accepted PoC risk.
    function deductBudget(uint256 campaignId, uint256 amount) external {
        require(!_locked, "E57"); _locked = true;
        require(msg.sender == settlementContract, "E25");
        Campaign storage c = _campaigns[campaignId];
        require(c.advertiser != address(0), "E01");
        require(c.status == CampaignStatus.Active, "E15");
        require(amount <= c.remainingBudget, "E16");

        // Reset daily cap on new day
        uint256 today = block.timestamp / 86400;
        if (today != c.lastSpendDay) {
            c.dailySpent = 0;
            c.lastSpendDay = today;
        }

        require(c.dailySpent + amount <= c.dailyCapPlanck, "E26");

        c.dailySpent += amount;
        c.remainingBudget -= amount;

        emit BudgetDeducted(campaignId, amount, c.remainingBudget);

        // Auto-complete if budget exhausted
        if (c.remainingBudget == 0) {
            c.status = CampaignStatus.Completed;
            emit CampaignCompleted(campaignId);
        }

        // Forward payment DOT to settlement contract for pull-payment distribution
        _send(settlementContract, amount);
        _locked = false;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site — avoids resolc codegen bug where multiple
    ///      transfer() sites produce broken RISC-V. Uses .call{value} (not .transfer())
    ///      because resolc may inline internal helpers, recreating the multi-site bug.
    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
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

    function getCampaignRemainingBudget(uint256 campaignId) external view returns (uint256) {
        return _campaigns[campaignId].remainingBudget;
    }

    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint256 remainingBudget, uint16 snapshotTakeRateBps
    ) {
        Campaign storage c = _campaigns[campaignId];
        return (uint8(c.status), c.publisher, c.bidCpmPlanck, c.remainingBudget, c.snapshotTakeRateBps);
    }
}
