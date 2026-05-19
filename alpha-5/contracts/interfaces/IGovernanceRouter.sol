// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IGovernanceRouter
/// @notice Interface for the governance routing contract used by AdminGovernance, Council, etc.
interface IGovernanceRouter {
    function activateCampaign(uint256 campaignId) external;
    function terminateCampaign(uint256 campaignId) external;
    function demoteCampaign(uint256 campaignId) external;
}
