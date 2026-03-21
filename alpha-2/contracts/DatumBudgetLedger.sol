// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
contract DatumBudgetLedger is IDatumBudgetLedger {
    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    address public owner;
    address public campaigns;
    address public settlement;
    address public lifecycle;

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

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
    }

    function setLifecycle(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        lifecycle = addr;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        owner = newOwner;
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

        emit BudgetInitialized(campaignId, budget, dailyCap);
    }

    // -------------------------------------------------------------------------
    // Budget deduction (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function deductAndTransfer(
        uint256 campaignId, uint256 amount, address recipient
    ) external returns (bool exhausted) {
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
    ) external returns (uint256 drained) {
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
    ) external returns (uint256 amount) {
        require(msg.sender == lifecycle, "E25");
        require(bps <= 10000, "E16");

        uint256 remaining = _budgets[campaignId].remaining;
        amount = (remaining * bps) / 10000;
        _budgets[campaignId].remaining = remaining - amount;

        if (amount > 0) {
            _send(recipient, amount);
        }
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
