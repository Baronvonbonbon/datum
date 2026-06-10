// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumTagCurator
/// @notice M5-fix: external curator for the approved-tag dictionary. Mirrors
///         the CouncilBlocklistCurator pattern — DatumCampaigns delegates
///         `isTagApproved` lookups so the tag whitelist can be governed
///         independently of the Campaigns owner key.
///
///         When `enforceTagRegistry` is enabled on Campaigns and a curator is
///         wired, only tags returned `true` by `isTagApproved` are accepted
///         on `setPublisherTags` and `createCampaign`.
interface IDatumTagCurator {
    function isTagApproved(bytes32 tag) external view returns (bool);
}
