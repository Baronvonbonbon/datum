// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaignsSettlement
/// @notice Slim interface for Settlement to read campaign state.
///         Alpha-2: remainingBudget removed (now on BudgetLedger).
interface IDatumCampaignsSettlement {
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint16 snapshotTakeRateBps
    );
    function getCampaignRelaySigner(uint256 campaignId) external view returns (address);
    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool);
    function getCampaignRewardToken(uint256 campaignId) external view returns (address);
    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256);
    /// @notice A3: effective AssuranceLevel (0/1/2). Reads the new canonical
    ///         storage with backward-compat for the legacy `requiresDualSig` flag.
    function getCampaignAssuranceLevel(uint256 campaignId) external view returns (uint8);
}
