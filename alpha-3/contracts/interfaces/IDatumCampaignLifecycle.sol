// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaignLifecycle
/// @notice Interface for campaign lifecycle transitions extracted from DatumCampaigns.
///         Handles complete, terminate, and expire with refund routing through BudgetLedger.
interface IDatumCampaignLifecycle {
    event CampaignCompleted(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId, uint256 terminationBlock);
    event CampaignExpired(uint256 indexed campaignId);

    /// @notice Complete a campaign (advertiser or settlement auto-complete).
    ///         Refunds remaining budget to advertiser via BudgetLedger.
    function completeCampaign(uint256 campaignId) external;

    /// @notice Terminate a campaign via governance nay vote.
    ///         10% slash to governance, 90% refund to advertiser via BudgetLedger.
    function terminateCampaign(uint256 campaignId) external;

    /// @notice Expire a Pending campaign past its timeout. Permissionless.
    ///         Full budget refund to advertiser via BudgetLedger.
    function expirePendingCampaign(uint256 campaignId) external;

    /// @notice P20: Expire an Active/Paused campaign with no settlement activity
    ///         for inactivityTimeoutBlocks. Permissionless.
    ///         Full budget refund to advertiser via BudgetLedger.
    function expireInactiveCampaign(uint256 campaignId) external;
}
