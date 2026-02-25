// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumCampaignsMinimal
/// @notice Minimal interface for contracts that only need campaign status and budget.
/// Avoids full Campaign struct ABI decode overhead in PVM.
interface IDatumCampaignsMinimal {
    enum CampaignStatus {
        Pending, Active, Paused, Completed, Terminated, Expired
    }

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus status);
    function getCampaignRemainingBudget(uint256 campaignId) external view returns (uint256);
    function activateCampaign(uint256 campaignId) external;
    function terminateCampaign(uint256 campaignId) external;
}
