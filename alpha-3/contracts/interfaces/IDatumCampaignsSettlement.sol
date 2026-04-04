// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumCampaignsSettlement
/// @notice Slim interface for Settlement to read campaign state.
///         Alpha-2: remainingBudget removed (now on BudgetLedger).
interface IDatumCampaignsSettlement {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    );
    function getCampaignRelaySigner(uint256 campaignId) external view returns (address);
    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool);
}
