// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumTagSystem
/// @notice Read + writer surface for the unified tag system: governance
///         tag dictionary, per-publisher tag sets, per-campaign required-tag
///         records, and lane-mode gating. Carved out of DatumCampaigns for
///         mainnet EIP-170 (alpha-4).
///
/// @dev    Two writer paths:
///           - `initializeCampaignTags(...)` is gated to `onlyCampaigns`
///             and called from DatumCampaigns._createCampaign.
///           - `setPublisherTags(...)` is publisher-facing (msg.sender is
///             the publisher themselves).
interface IDatumTagSystem {
    // ── Per-claim read ────────────────────────────────────────────────────

    /// @notice True if `publisher` satisfies every tag in `requiredTags`.
    ///         Tags inside the post-removal grace window still count as held.
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool);

    /// @notice Convenience over `hasAllTags`: looks up the campaign's
    ///         required tags directly. Single staticcall in the per-claim
    ///         path saves one round trip vs callers that fetch tags + check.
    function hasAllRequiredTags(address publisher, uint256 campaignId) external view returns (bool);

    // ── Per-campaign data ─────────────────────────────────────────────────

    /// @notice Required tag set for a campaign (locked at create time).
    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory);

    /// @notice Snapshot of the campaign publisher's tags at campaign creation.
    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory);

    /// @notice Per-campaign tag mode: 0 Any, 1 StakeGated, 2 Curated.
    function campaignTagMode(uint256 campaignId) external view returns (uint8);

    // ── Per-publisher data ────────────────────────────────────────────────

    function getPublisherTags(address publisher) external view returns (bytes32[] memory);
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory);
    function publisherHasTag(address publisher, bytes32 tag) external view returns (bool);

    // ── Tag dictionary ────────────────────────────────────────────────────

    function approvedTags(bytes32 tag) external view returns (bool);
    function listApprovedTags() external view returns (bytes32[] memory);

    // ── Writers (auth-gated inside the contract) ──────────────────────────

    /// @notice Campaigns-only seeding at create time.
    ///         - Validates each required tag against the publisher's tag set.
    ///         - Re-validates each required tag under the current lane mode.
    ///         - Snapshots the publisher's tag set into per-campaign storage.
    function initializeCampaignTags(
        uint256 campaignId,
        address publisher,
        bytes32[] calldata requiredTags
    ) external;
}
