// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumBudgetLedger
/// @notice Interface for per-campaign budget management extracted from DatumCampaigns.
///         Holds escrowed DOT, enforces daily caps, and routes payments.
interface IDatumBudgetLedger {
    event BudgetInitialized(uint256 indexed campaignId, uint256 budget, uint256 dailyCap);
    event BudgetDeducted(uint256 indexed campaignId, uint256 amount, uint256 remaining);
    event BudgetDrained(uint256 indexed campaignId, address indexed advertiser, uint256 amount);

    /// @notice Initialize budget for a newly created campaign. Called by Campaigns.
    /// @dev msg.value = budget amount held in escrow
    function initializeBudget(
        uint256 campaignId, uint256 budget, uint256 dailyCap
    ) external payable;

    /// @notice Deduct from budget and transfer DOT to recipient. Called by Settlement.
    /// @dev Enforces daily cap. Returns true if budget is now exhausted (auto-complete signal).
    function deductAndTransfer(
        uint256 campaignId, uint256 amount, address recipient
    ) external returns (bool exhausted);

    /// @notice Drain remaining budget to advertiser on complete/terminate/expire. Called by Lifecycle.
    function drainToAdvertiser(
        uint256 campaignId, address advertiser
    ) external returns (uint256 drained);

    /// @notice Drain a fraction of remaining budget. Called by Lifecycle for termination slash.
    /// @param campaignId Campaign to drain from
    /// @param recipient Where to send the funds
    /// @param bps Basis points of remaining budget to drain (e.g. 1000 = 10%)
    /// @return amount The amount actually drained
    function drainFraction(
        uint256 campaignId, address recipient, uint256 bps
    ) external returns (uint256 amount);

    function getRemainingBudget(uint256 campaignId) external view returns (uint256);
    function getDailyCap(uint256 campaignId) external view returns (uint256);

    /// @notice P20: Last block where a settlement deduction occurred for this campaign.
    ///         Set to block.number at creation, updated on each deductAndTransfer().
    function lastSettlementBlock(uint256 campaignId) external view returns (uint256);
}
