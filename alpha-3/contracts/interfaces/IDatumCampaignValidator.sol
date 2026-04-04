// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumCampaignValidator
/// @notice Validates campaign creation — blocklist, allowlist, publisher registration,
///         and tag-based targeting (TX-1).
///         Extracted from DatumCampaigns (SE-3) for PVM headroom and MG-1 enablement.
interface IDatumCampaignValidator {
    /// @notice Validate an advertiser creating a campaign with a publisher.
    /// @param advertiser The campaign creator (msg.sender in Campaigns)
    /// @param publisher The target publisher (address(0) for open campaigns)
    /// @param requiredTags Campaign's required tags (empty = no tag filtering)
    /// @return valid Whether creation should proceed
    /// @return takeRateBps Publisher take rate snapshot (5000 for open campaigns)
    /// @return snapshotRelaySigner Publisher's relay signer at creation time (address(0) for open)
    /// @return snapshotTags Publisher's full tag set at creation time (empty for open campaigns)
    function validateCreation(
        address advertiser,
        address publisher,
        bytes32[] calldata requiredTags
    ) external view returns (bool valid, uint16 takeRateBps, address snapshotRelaySigner, bytes32[] memory snapshotTags);
}
