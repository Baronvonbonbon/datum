// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumGovernanceV2Minimal
/// @notice Minimal interface for DatumGovernanceV2 used by DatumGovernanceSlash.
///         Avoids importing the full contract which bloats PVM bytecode.
interface IDatumGovernanceV2Minimal {
    function resolved(uint256 campaignId) external view returns (bool);
    function resolvedWinningWeight(uint256 campaignId) external view returns (uint256);
    function getVote(uint256 campaignId, address voter) external view returns (uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock);
    function convictionWeight(uint8 conviction) external view returns (uint256);
    function slashCollected(uint256 campaignId) external view returns (uint256);
    function slashAction(uint8 action, uint256 campaignId, address recipient, uint256 amount) external;
}
