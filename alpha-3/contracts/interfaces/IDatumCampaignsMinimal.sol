// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaignsMinimal
/// @notice Minimal interface for GovernanceV2/Slash/Relay — campaign status reads + governance activation.
///         Alpha-2: terminateCampaign moved to IDatumCampaignLifecycle (GovernanceV2 calls Lifecycle directly).
///         getCampaignForSettlement returns 4 values (no remainingBudget).
interface IDatumCampaignsMinimal {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    );
    function activateCampaign(uint256 campaignId) external;
}
