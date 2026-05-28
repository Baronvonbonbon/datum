// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaignValidator
/// @notice Validates campaign creation — blocklist, allowlist, publisher registration,
///         and tag-based targeting (TX-1).
///         Extracted from DatumCampaigns (SE-3) for PVM headroom and MG-1 enablement.
interface IDatumCampaignValidator {
    /// @notice Emitted when the targeting registry is cleared (set to address(0)).
    event TargetingRegistryCleared();

    /// @notice Validate an advertiser creating a campaign with a publisher.
    /// @param advertiser The campaign creator (msg.sender in Campaigns)
    /// @param publisher The target publisher (address(0) for open campaigns)
    /// @param requiredTags Campaign's required tags (empty = no tag filtering)
    /// @return valid Whether creation should proceed
    /// @return takeRateBps Publisher take rate snapshot (5000 for open campaigns)
    /// @return snapshotRelaySigner Publisher's relay signer at creation time (address(0) for open)
    /// @return snapshotTags Publisher's full tag set at creation time (empty for open campaigns)
    /// @return allowlistWasEnabled Whether publisher's allowlist was enabled at creation (AUDIT-005)
    function validateCreation(
        address advertiser,
        address publisher,
        bytes32[] calldata requiredTags
    ) external view returns (bool valid, uint16 takeRateBps, address snapshotRelaySigner, bytes32[] memory snapshotTags, bool allowlistWasEnabled);

    /// @notice Store allowlist snapshot for a campaign at creation time.
    ///         Only callable by the Campaigns contract.
    /// @param campaignId The campaign being created
    /// @param advertiser The advertiser whose allowlist status to snapshot
    /// @param isAllowed Whether the advertiser was on the publisher's allowlist
    function storeAllowlistSnapshot(uint256 campaignId, address advertiser, bool isAllowed) external;
}
