// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumPublisherReputation
/// @notice BM-8 + BM-9: Per-publisher reputation scoring and cross-campaign anomaly detection.
interface IDatumPublisherReputation {
    event SettlementRecorded(
        address indexed publisher,
        uint256 indexed campaignId,
        uint256 settled,
        uint256 rejected
    );
    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);

    /// @notice Record settled and rejected impressions for a publisher in a campaign.
    ///         Only callable by approved reporters (relay bot).
    function recordSettlement(
        address publisher,
        uint256 campaignId,
        uint256 settled,
        uint256 rejected
    ) external;

    /// @notice Returns the publisher's global acceptance score in basis points (0–10000).
    ///         10000 = 100% accepted, 0 = 100% rejected.
    ///         Returns 10000 (perfect) if no data yet.
    function getScore(address publisher) external view returns (uint16 score);

    /// @notice BM-9: Returns true if the publisher's per-campaign rejection rate exceeds
    ///         2× their global rejection rate with a minimum sample of 10 claims.
    function isAnomaly(address publisher, uint256 campaignId) external view returns (bool);

    /// @notice Global stats for a publisher.
    function getPublisherStats(address publisher)
        external
        view
        returns (uint256 settled, uint256 rejected, uint16 score);

    /// @notice Per-campaign stats for a publisher.
    function getCampaignStats(address publisher, uint256 campaignId)
        external
        view
        returns (uint256 settled, uint256 rejected);
}
