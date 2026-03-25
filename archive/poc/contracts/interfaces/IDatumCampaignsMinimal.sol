// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumCampaignsMinimal
/// @notice Minimal interface for contracts that only need campaign status and budget.
/// Avoids full Campaign struct ABI decode overhead in PVM.
/// Uses getCampaignForSettlement tuple instead of individual getters (PVM size).
interface IDatumCampaignsMinimal {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint256 remainingBudget, uint16 snapshotTakeRateBps
    );
    function activateCampaign(uint256 campaignId) external;
    function terminateCampaign(uint256 campaignId) external;
}
