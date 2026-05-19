// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumReports
/// @notice Read surface for the community-reporting module. Counters live
///         per-campaign and per-actor (publisher / advertiser).
interface IDatumReports {
    function pageReports(uint256 campaignId) external view returns (uint256);
    function adReports(uint256 campaignId) external view returns (uint256);
    function publisherReports(address publisher) external view returns (uint256);
    function advertiserReports(address advertiser) external view returns (uint256);
}
