// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumBudgetLedger
/// @notice Interface for per-campaign per-pot budget management.
///         Each campaign has up to 3 action pots: 0=view, 1=click, 2=remote-action.
///         Budget is escrowed per (campaignId, actionType).
interface IDatumBudgetLedger {
    event BudgetInitialized(uint256 indexed campaignId, uint8 actionType, uint256 budget, uint256 dailyCap);
    event BudgetDeducted(uint256 indexed campaignId, uint8 actionType, uint256 amount, uint256 remaining);
    event BudgetDrained(uint256 indexed campaignId, address indexed advertiser, uint256 amount);
    /// @notice M-1: Refund queued for advertiser pull.
    event AdvertiserRefundQueued(uint256 indexed campaignId, address indexed advertiser, uint256 amount);
    /// @notice M-1: Advertiser pulled their queued refund.
    event AdvertiserRefundClaimed(address indexed advertiser, address indexed recipient, uint256 amount);

    /// @notice Initialize a single action-pot budget for a campaign. Called once per pot at campaign creation.
    /// @dev msg.value must equal budget.
    function initializeBudget(
        uint256 campaignId,
        uint8   actionType,
        uint256 budget,
        uint256 dailyCap
    ) external payable;

    /// @notice Deduct from a specific pot and transfer DOT to recipient. Called by Settlement.
    /// @dev Enforces daily cap for the pot. Returns true if this pot is now exhausted.
    /// @dev DEPRECATED for the batch settle path (one native transfer per claim exhausts
    ///      pallet-revive's storage-deposit allowance on multi-claim batches). Settlement now
    ///      uses `deduct` per claim + a single `transferSettled` per batch. Retained for compat.
    function deductAndTransfer(
        uint256 campaignId,
        uint8   actionType,
        uint256 amount,
        address recipient
    ) external returns (bool exhausted);

    /// @notice Deduct from a specific pot WITHOUT transferring DOT (state-only). Called by
    ///         Settlement once per claim; the batch's aggregate is moved once via
    ///         `transferSettled`. Enforces daily cap. Returns true if the pot is now exhausted.
    function deduct(
        uint256 campaignId,
        uint8   actionType,
        uint256 amount
    ) external returns (bool exhausted);

    /// @notice Transfer a previously-deducted aggregate of DOT to `recipient` (the PaymentVault).
    ///         Called once per settle batch by Settlement, after the per-claim `deduct` calls.
    /// @dev Collapses N per-claim native transfers into one, so a multi-claim batch has the
    ///      storage-deposit footprint of a single claim (pallet-revive multi-claim fix).
    function transferSettled(address recipient, uint256 amount) external;

    /// @notice Queue all remaining budget across all pots as an advertiser refund.
    ///         M-1 (pull pattern): records into `pendingAdvertiserRefund[advertiser]`.
    ///         Advertiser must call claimAdvertiserRefund() to actually receive funds.
    ///         Called by Lifecycle on complete / terminate / expire.
    function drainToAdvertiser(
        uint256 campaignId,
        address advertiser
    ) external returns (uint256 drained);

    /// @notice M-1: Pull queued advertiser refund to msg.sender.
    function claimAdvertiserRefund() external;

    /// @notice M-1: Pull queued advertiser refund to a chosen recipient.
    function claimAdvertiserRefundTo(address recipient) external;

    /// @notice M-1: Pending refund amount for an advertiser.
    function pendingAdvertiserRefund(address advertiser) external view returns (uint256);

    /// @notice Drain a fraction of total remaining budget across all pots. Called by Lifecycle for slashing.
    /// @param bps Basis points of each pot's remaining budget to drain (e.g. 1000 = 10%).
    function drainFraction(
        uint256 campaignId,
        address recipient,
        uint256 bps
    ) external returns (uint256 amount);

    /// @notice Remaining budget for a specific action pot.
    function getRemainingBudget(uint256 campaignId, uint8 actionType) external view returns (uint256);

    /// @notice Total remaining budget summed across all action pots (0, 1, 2).
    function getTotalRemainingBudget(uint256 campaignId) external view returns (uint256);

    /// @notice Daily cap for a specific action pot.
    function getDailyCap(uint256 campaignId, uint8 actionType) external view returns (uint256);

    /// @notice P20: Last block where a settlement deduction occurred for this campaign (any pot).
    function lastSettlementBlock(uint256 campaignId) external view returns (uint256);
}
