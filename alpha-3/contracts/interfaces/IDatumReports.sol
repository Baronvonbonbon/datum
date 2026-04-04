// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumReports
/// @notice Interface for community reporting of campaign pages and ads.
///         Counters are per-campaign and cumulative per publisher/advertiser.
///         No on-chain deduplication — Sybil filtering happens off-chain.
interface IDatumReports {
    // reason: 1=spam, 2=misleading, 3=inappropriate, 4=broken, 5=other
    event PageReported(uint256 indexed campaignId, address indexed publisher, address indexed reporter, uint8 reason);
    event AdReported(uint256 indexed campaignId, address indexed advertiser, address indexed reporter, uint8 reason);

    function reportPage(uint256 campaignId, uint8 reason) external;
    function reportAd(uint256 campaignId, uint8 reason) external;

    function pageReports(uint256 campaignId) external view returns (uint256);
    function adReports(uint256 campaignId) external view returns (uint256);
    function publisherReports(address publisher) external view returns (uint256);
    function advertiserReports(address advertiser) external view returns (uint256);
}
