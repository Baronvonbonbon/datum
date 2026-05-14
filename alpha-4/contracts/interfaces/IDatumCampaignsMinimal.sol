// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaignsMinimal
/// @notice Minimal interface for GovernanceV2/Slash/Relay — campaign status reads + governance activation.
///         Alpha-2: terminateCampaign moved to IDatumCampaignLifecycle (GovernanceV2 calls Lifecycle directly).
///         Alpha-3 v10: getCampaignForSettlement returns 3 values (bidCpmPlanck removed; CPM lives in ActionPotConfig[]).
interface IDatumCampaignsMinimal {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher,
        uint16 snapshotTakeRateBps
    );
    function activateCampaign(uint256 campaignId) external;
}

/// @notice Advertiser-of-record read used by ActivationBonds.settleMute to
///         compensate the advertiser when a mute is rejected. Kept out of
///         the minimal interface so the GovernanceRouter passthrough doesn't
///         need a third stub. ActivationBonds uses try/catch against this
///         shape so legacy Campaigns implementations remain compatible.
interface IDatumCampaignsAdvertiser {
    function getCampaignAdvertiser(uint256 campaignId) external view returns (address);
}
