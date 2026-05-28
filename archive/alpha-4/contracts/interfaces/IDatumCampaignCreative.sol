// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumCampaignCreative
/// @notice Read surface for the unified per-campaign creative-mapping
///         sidecar. Owns both legacy IPFS metadata hashes AND Polkadot
///         Bulletin Chain references. Frontends prefer the Bulletin
///         reference when set and fall back to the IPFS hash otherwise;
///         both live behind this single module.
interface IDatumCampaignCreative {
    struct BulletinRef {
        bytes32 cidDigest;
        uint8   cidCodec;
        uint32  bulletinBlock;
        uint32  bulletinIndex;
        uint64  expiryHubBlock;
        uint64  retentionHorizonBlock;
        uint32  version;
    }

    /// @notice Bulletin Chain reference for a campaign, or the zero-value
    ///         struct when none is set.
    function getBulletinCreative(uint256 campaignId) external view returns (BulletinRef memory);

    /// @notice True when the campaign's Bulletin creative is within the
    ///         renewal lead time of expiring.
    function isBulletinRenewalDue(uint256 campaignId) external view returns (bool);

    /// @notice Legacy IPFS metadata hash for a campaign (bytes32 multihash
    ///         digest). Zero when never set.
    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32);
}
