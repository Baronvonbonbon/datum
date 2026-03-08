// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumGovernanceSlash
/// @notice Interface for slash pool finalization and winner reward claims.
interface IDatumGovernanceSlash {
    function finalizeSlash(uint256 campaignId) external;
    function claimSlashReward(uint256 campaignId) external;
    function getClaimable(uint256 campaignId, address voter) external view returns (uint256);
    function winningWeight(uint256 campaignId) external view returns (uint256);
    function finalized(uint256 campaignId) external view returns (bool);
}
