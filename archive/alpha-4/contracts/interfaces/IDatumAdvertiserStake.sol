// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumAdvertiserStake
/// @notice CB4: Advertiser-side aggregate stake. Mirrors IDatumPublisherStake.
///         Settlement records budget-spent against the bonding curve;
///         Campaigns.createCampaign gates on adequate stake; AdvertiserGovernance
///         slashes on fraud.
interface IDatumAdvertiserStake {
    struct UnstakeRequest {
        uint256 amount;
        uint256 availableBlock;
    }

    event Staked(address indexed advertiser, uint256 amount, uint256 totalStaked);
    event UnstakeRequested(address indexed advertiser, uint256 amount, uint256 availableAtBlock);
    event Unstaked(address indexed advertiser, uint256 amount);
    event BudgetSpentRecorded(address indexed advertiser, uint256 amount, uint256 cumulative);
    event Slashed(address indexed advertiser, uint256 amount, address indexed recipient);
    event ParamsUpdated(uint256 base, uint256 perDOTSpent, uint256 unstakeDelay);

    function stake() external payable;
    function requestUnstake(uint256 amount) external;
    function unstake() external;
    function recordBudgetSpent(address advertiser, uint256 amount) external;
    function slash(address advertiser, uint256 amount, address recipient) external;

    function staked(address advertiser) external view returns (uint256);
    function cumulativeBudgetSpent(address advertiser) external view returns (uint256);
    function pendingUnstake(address advertiser) external view returns (UnstakeRequest memory);
    function requiredStake(address advertiser) external view returns (uint256);
    function isAdequatelyStaked(address advertiser) external view returns (bool);
}
