// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumCampaignsSettlement
/// @notice Slim interface for DatumSettlement — avoids full Campaign struct ABI decode
/// overhead in PVM bytecode. Uses getCampaignForSettlement for the 5 fields Settlement needs.
interface IDatumCampaignsSettlement {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint256 remainingBudget, uint16 snapshotTakeRateBps
    );
    function deductBudget(uint256 campaignId, uint256 amount) external;
}
