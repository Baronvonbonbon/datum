// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title DatumBudgetLedger
/// @notice Per-campaign per-pot budget escrow and daily cap enforcement.
///         Supports three action pots per campaign: 0=view, 1=click, 2=remote-action.
///         Budget is keyed on (campaignId, actionType).
///
///         Campaigns initializes each pot at campaign creation (payable, once per pot).
///         Settlement calls deductAndTransfer with the actionType to deduct the right pot.
///         Lifecycle calls drainToAdvertiser/drainFraction which loop all pots internally.
///
///         Daily cap uses block.timestamp / 86400 as day index (accepted PoC risk).
///         Single _send() site for native transfers.
contract DatumBudgetLedger is IDatumBudgetLedger, ReentrancyGuard, DatumOwnable {
    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    IDatumCampaigns public campaigns;
    address public settlement;
    address public lifecycle;
    /// @dev SL-1: Dust recipient fixed at deploy — unaffected by ownership transfers.
    address public immutable treasury;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Budget {
        uint256 remaining;
        uint256 dailyCap;
        uint256 dailySpent;
        uint256 lastSpendDay;
    }

    /// @dev Keyed by (campaignId, actionType). actionType: 0=view, 1=click, 2=remote-action.
    mapping(uint256 => mapping(uint8 => Budget)) private _budgets;

    /// @dev P20: Tracks the last block where a deduction occurred for each campaign (any pot).
    mapping(uint256 => uint256) public lastSettlementBlock;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        treasury = msg.sender; // SL-1: immutable dust recipient
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaigns", address(campaigns), addr);
        campaigns = IDatumCampaigns(addr);
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

    // -------------------------------------------------------------------------
    // Budget initialization (Campaigns only — once per pot)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function initializeBudget(
        uint256 campaignId,
        uint8   actionType,
        uint256 budget,
        uint256 dailyCap
    ) external payable {
        require(msg.sender == address(campaigns), "E25");
        require(actionType <= 2, "E88"); // E88: invalid action type
        require(msg.value == budget, "E16");
        require(_budgets[campaignId][actionType].remaining == 0, "E14"); // prevent double-init

        _budgets[campaignId][actionType] = Budget({
            remaining: budget,
            dailyCap: dailyCap,
            dailySpent: 0,
            lastSpendDay: 0
        });
        if (lastSettlementBlock[campaignId] == 0) {
            lastSettlementBlock[campaignId] = block.number;
        }

        emit BudgetInitialized(campaignId, actionType, budget, dailyCap);
    }

    // -------------------------------------------------------------------------
    // Budget deduction (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function deductAndTransfer(
        uint256 campaignId,
        uint8   actionType,
        uint256 amount,
        address recipient
    ) external nonReentrant returns (bool exhausted) {
        require(msg.sender == settlement, "E25");
        require(actionType <= 2, "E88");

        Budget storage b = _budgets[campaignId][actionType];
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

        emit BudgetDeducted(campaignId, actionType, amount, b.remaining);

        exhausted = (b.remaining == 0);

        _send(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Budget drain (Lifecycle only — loops all pots internally)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function drainToAdvertiser(
        uint256 campaignId,
        address advertiser
    ) external nonReentrant returns (uint256 drained) {
        require(msg.sender == lifecycle, "E25");

        for (uint8 t = 0; t <= 2; t++) {
            uint256 rem = _budgets[campaignId][t].remaining;
            if (rem > 0) {
                _budgets[campaignId][t].remaining = 0;
                drained += rem;
            }
        }

        emit BudgetDrained(campaignId, advertiser, drained);

        if (drained > 0) {
            _send(advertiser, drained);
        }
    }

    /// @inheritdoc IDatumBudgetLedger
    function drainFraction(
        uint256 campaignId,
        address recipient,
        uint256 bps
    ) external nonReentrant returns (uint256 amount) {
        require(msg.sender == lifecycle, "E25");
        require(bps <= 10000, "E16");

        for (uint8 t = 0; t <= 2; t++) {
            uint256 remaining = _budgets[campaignId][t].remaining;
            if (remaining == 0) continue;
            // AUDIT-009: Use Math.mulDiv for overflow-safe precision; ceiling via +1 if remainder > 0
            uint256 floor = Math.mulDiv(remaining, bps, 10000);
            uint256 rem = (remaining * bps) % 10000;
            uint256 potAmount = rem > 0 ? floor + 1 : floor;
            _budgets[campaignId][t].remaining = remaining - potAmount;
            amount += potAmount;
        }

        if (amount > 0) {
            _send(recipient, amount);
        }
    }

    // -------------------------------------------------------------------------
    // Dust sweep (M4) — permissionless, terminal campaigns only
    // -------------------------------------------------------------------------

    event DustSwept(uint256 indexed campaignId, address recipient, uint256 amount);

    /// @notice Sweep rounding dust from terminal campaigns to protocol treasury.
    ///         Permissionless — anyone can call. Only works for terminal campaign statuses (3,4,5).
    function sweepDust(uint256 campaignId) external nonReentrant {
        // Check campaign is terminal
        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(uint8(status) >= 3, "E14"); // 3=Completed, 4=Terminated, 5=Expired

        uint256 dust;
        for (uint8 t = 0; t <= 2; t++) {
            uint256 rem = _budgets[campaignId][t].remaining;
            if (rem > 0) {
                _budgets[campaignId][t].remaining = 0;
                dust += rem;
            }
        }
        require(dust > 0, "E03");

        emit DustSwept(campaignId, treasury, dust);
        _send(treasury, dust);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function getRemainingBudget(uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _budgets[campaignId][actionType].remaining;
    }

    /// @inheritdoc IDatumBudgetLedger
    function getTotalRemainingBudget(uint256 campaignId) external view returns (uint256 total) {
        for (uint8 t = 0; t <= 2; t++) {
            total += _budgets[campaignId][t].remaining;
        }
    }

    /// @inheritdoc IDatumBudgetLedger
    function getDailyCap(uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _budgets[campaignId][actionType].dailyCap;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site.
    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
    }

    receive() external payable {}
}
