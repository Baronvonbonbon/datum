// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumGovernanceV2
/// @notice Interface for DATUM dynamic governance voting with symmetric slash.
interface IDatumGovernanceV2 {
    function vote(uint256 campaignId, bool aye, uint8 conviction) external payable;
    function withdraw(uint256 campaignId) external;
    function evaluateCampaign(uint256 campaignId) external;
    function slashAction(uint8 action, uint256 campaignId, address target, uint256 value) external;
    function setSlashContract(address _slash) external;

    function getVote(uint256 campaignId, address voter) external view returns (
        uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock
    );
    function ayeWeighted(uint256 campaignId) external view returns (uint256);
    function nayWeighted(uint256 campaignId) external view returns (uint256);
    function resolved(uint256 campaignId) external view returns (bool);
    function slashCollected(uint256 campaignId) external view returns (uint256);
    function slashBps() external view returns (uint256);
    function quorumWeighted() external view returns (uint256);
    function baseLockupBlocks() external view returns (uint256);
    function maxLockupBlocks() external view returns (uint256);
}
