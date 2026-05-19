// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumCampaignAllowlist
/// @notice Read surface for the per-campaign publisher-allowlist module
///         that ClaimValidator consults during validation. Reads are
///         per-claim, so the surface stays minimal.
interface IDatumCampaignAllowlist {
    /// @notice Number of publishers allowlisted for `campaignId`. Zero means
    ///         "open campaign" — claim-validation logic falls back to the
    ///         tag-match path.
    function campaignAllowedPublisherCount(uint256 campaignId) external view returns (uint16);

    /// @notice True iff `publisher` is on the allowlist for `campaignId`.
    function isAllowedPublisher(uint256 campaignId, address publisher) external view returns (bool);

    /// @notice Per-(campaign, publisher) take-rate snapshot. Locked at the
    ///         moment of allowlist add; later publisher rate changes do not
    ///         affect existing entries.
    function getCampaignPublisherTakeRate(uint256 campaignId, address publisher) external view returns (uint16);

    /// @notice Campaigns-only writer: seed the allowlist with a single named
    ///         publisher at create-time. Reverts on double-init.
    function initializeFor(uint256 campaignId, address publisher, uint16 takeRateBps) external;
}
