// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumGovernanceRewards
/// @notice Interface for aye reward distribution, claims, and failed nay resolution.
///
/// This contract holds aye reward DOT (received via distributeAyeRewards).
/// It reads vote state from DatumGovernanceVoting via cross-contract views.
///
/// Distribution model (MVP): aye reward shares are computed off-chain and credited
/// per-voter by the owner via creditAyeReward. distributeSlashRewards iterates
/// nay voters on-chain since it must call voting.rewardsAction per voter.
interface IDatumGovernanceRewards {
    event AyeRewardClaimed(uint256 indexed campaignId, address indexed voter, uint256 amount);
    event SlashRewardClaimed(uint256 indexed campaignId, address indexed voter, uint256 amount);
    event StakeWithdrawn(uint256 indexed campaignId, address indexed voter, uint256 amount);
    event FailedNayResolved(uint256 indexed campaignId, address indexed voter, uint256 totalFailedNays);

    /// @notice Credit aye reward to a specific voter (owner supplies off-chain computed amounts).
    ///         DOT is sent with the call; entire msg.value goes to the voter's claimable balance.
    function creditAyeReward(uint256 campaignId, address voter) external payable;

    function claimAyeReward(uint256 campaignId) external;
    function distributeSlashRewards(uint256 campaignId) external;
    function claimSlashReward(uint256 campaignId) external;
    function withdrawStake(uint256 campaignId) external;
    function resolveFailedNay(uint256 campaignId) external;
    function ayeClaimable(uint256 campaignId, address voter) external view returns (uint256);
}
