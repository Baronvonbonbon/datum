// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IDatumBudgetLedger.sol";

/// @title DatumBudgetLedger
/// @notice Per-campaign budget escrow and daily cap enforcement.
///         Extracted from DatumCampaigns (alpha) to free PVM bytecode headroom.
///
///         Campaigns initializes budget at campaign creation (payable).
///         Settlement calls deductAndTransfer to deduct + forward DOT to PaymentVault.
///         Lifecycle calls drainToAdvertiser/drainFraction for refund paths.
///
///         Daily cap uses block.timestamp / 86400 as day index (accepted PoC risk).
///         Single _send() site to avoid resolc codegen bug.
///
///         Hardening: ReentrancyGuard on all value-transfer paths,
///         ContractReferenceChanged events on admin setters.
contract DatumBudgetLedger is IDatumBudgetLedger, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    address public campaigns;
    address public settlement;
    address public lifecycle;
    /// @dev SL-1: Dust recipient fixed at deploy — unaffected by ownership transfers.
    address public immutable treasury;

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Budget {
        uint256 remaining;
        uint256 dailyCap;
        uint256 dailySpent;
        uint256 lastSpendDay;
    }

    mapping(uint256 => Budget) private _budgets;

    /// @dev P20: Tracks the last block where a deduction occurred for each campaign.
    ///      Used by CampaignLifecycle.expireInactiveCampaign() to detect stale campaigns.
    mapping(uint256 => uint256) public lastSettlementBlock;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
        treasury = msg.sender; // SL-1: immutable dust recipient
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaigns", campaigns, addr);
        campaigns = addr;
    }

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("settlement", settlement, addr);
        settlement = addr;
    }

    function setLifecycle(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", lifecycle, addr);
        lifecycle = addr;
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
    // Budget initialization (Campaigns only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function initializeBudget(
        uint256 campaignId, uint256 budget, uint256 dailyCap
    ) external payable {
        require(msg.sender == campaigns, "E25");
        require(msg.value == budget, "E16");
        require(_budgets[campaignId].remaining == 0, "E14");

        _budgets[campaignId] = Budget({
            remaining: budget,
            dailyCap: dailyCap,
            dailySpent: 0,
            lastSpendDay: 0
        });
        lastSettlementBlock[campaignId] = block.number;

        emit BudgetInitialized(campaignId, budget, dailyCap);
    }

    // -------------------------------------------------------------------------
    // Budget deduction (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function deductAndTransfer(
        uint256 campaignId, uint256 amount, address recipient
    ) external nonReentrant returns (bool exhausted) {
        require(msg.sender == settlement, "E25");

        Budget storage b = _budgets[campaignId];
        require(amount <= b.remaining, "E16");

        // Daily cap reset on new day
        uint256 today = block.timestamp / 86400;
        if (today != b.lastSpendDay) {
            b.dailySpent = 0;
            b.lastSpendDay = today;
        }

        require(b.dailySpent + amount <= b.dailyCap, "E26");

        b.dailySpent += amount;
        b.remaining -= amount;
        lastSettlementBlock[campaignId] = block.number;

        emit BudgetDeducted(campaignId, amount, b.remaining);

        exhausted = (b.remaining == 0);

        // Forward DOT to recipient (PaymentVault)
        _send(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Budget drain (Lifecycle only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function drainToAdvertiser(
        uint256 campaignId, address advertiser
    ) external nonReentrant returns (uint256 drained) {
        require(msg.sender == lifecycle, "E25");

        drained = _budgets[campaignId].remaining;
        _budgets[campaignId].remaining = 0;

        emit BudgetDrained(campaignId, advertiser, drained);

        if (drained > 0) {
            _send(advertiser, drained);
        }
    }

    /// @inheritdoc IDatumBudgetLedger
    function drainFraction(
        uint256 campaignId, address recipient, uint256 bps
    ) external nonReentrant returns (uint256 amount) {
        require(msg.sender == lifecycle, "E25");
        require(bps <= 10000, "E16");

        uint256 remaining = _budgets[campaignId].remaining;
        // AUDIT-009: Use Math.mulDiv for overflow-safe precision; ceiling via +1 if remainder > 0
        uint256 floor = Math.mulDiv(remaining, bps, 10000);
        uint256 rem = (remaining * bps) % 10000; // safe: if mulDiv didn't overflow, this won't
        amount = rem > 0 ? floor + 1 : floor; // ceiling division
        _budgets[campaignId].remaining = remaining - amount;

        if (amount > 0) {
            _send(recipient, amount);
        }
    }

    // -------------------------------------------------------------------------
    // Dust sweep (M4) — permissionless, terminal campaigns only
    // -------------------------------------------------------------------------

    event DustSwept(uint256 indexed campaignId, address recipient, uint256 amount);

    /// @notice Sweep rounding dust from terminal campaigns to protocol owner.
    ///         Permissionless — anyone can call. Only works when remaining > 0
    ///         and campaign status is Completed (3), Terminated (4), or Expired (5).
    function sweepDust(uint256 campaignId) external nonReentrant {
        uint256 dust = _budgets[campaignId].remaining;
        require(dust > 0, "E03");

        // Check campaign is terminal via staticcall to getCampaignStatus
        (bool ok, bytes memory ret) = campaigns.staticcall(
            abi.encodeWithSignature("getCampaignStatus(uint256)", campaignId)
        );
        require(ok && ret.length >= 32, "E01");
        uint8 status = abi.decode(ret, (uint8));
        require(status >= 3, "E14");  // 3=Completed, 4=Terminated, 5=Expired

        _budgets[campaignId].remaining = 0;
        emit DustSwept(campaignId, treasury, dust);
        _send(treasury, dust);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getRemainingBudget(uint256 campaignId) external view returns (uint256) {
        return _budgets[campaignId].remaining;
    }

    function getDailyCap(uint256 campaignId) external view returns (uint256) {
        return _budgets[campaignId].dailyCap;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site — avoids resolc codegen bug.
    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
    }

    receive() external payable {}
}
