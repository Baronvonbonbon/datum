// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumTokenRewardVault
/// @notice Interface for the ERC-20 token reward vault.
///         Advertisers deposit ERC-20 token budgets at campaign creation.
///         Settlement credits users; users withdraw via pull pattern.
interface IDatumTokenRewardVault {
    event TokenBudgetDeposited(uint256 indexed campaignId, address indexed token, uint256 amount);
    event TokenRewardCredited(uint256 indexed campaignId, address indexed token, address indexed user, uint256 amount);
    event BudgetExhausted(uint256 indexed campaignId, address indexed token);
    event TokenWithdrawal(address indexed user, address indexed token, uint256 amount);
    event TokenBudgetReclaimed(uint256 indexed campaignId, address indexed token, address indexed advertiser, uint256 amount);

    /// @notice Advertiser deposits ERC-20 token budget for a campaign.
    ///         Requires prior ERC-20 approve() from advertiser.
    function depositCampaignBudget(uint256 campaignId, address token, uint256 amount) external;

    /// @notice Credit token reward to user. Called by Settlement only.
    function creditReward(uint256 campaignId, address token, address user, uint256 amount) external;

    /// @notice User withdraws accumulated token balance (pull pattern).
    function withdraw(address token) external;

    /// @notice User withdraws accumulated token balance to a specified recipient (sweep to cold wallet).
    function withdrawTo(address token, address recipient) external;

    /// @notice Advertiser reclaims remaining token budget after campaign ends/expires.
    function reclaimExpiredBudget(uint256 campaignId, address token) external;

    function userTokenBalance(address token, address user) external view returns (uint256);
    function campaignTokenBudget(address token, uint256 campaignId) external view returns (uint256);
}
