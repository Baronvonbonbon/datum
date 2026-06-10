// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumPublisherReputation
/// @notice Settlement-facing surface for the publisher-reputation module.
///         Reputation state was un-merged from DatumSettlement back into
///         its own contract to keep Settlement under EIP-170 and so the
///         module is independently upgradable via the governance router.
interface IDatumPublisherReputation {
    /// @notice Reputation gate read by Settlement before processing a batch.
    ///         Returns true when the publisher's global acceptance score
    ///         meets or exceeds the contract's `minReputationScore` floor.
    ///         Always true when the floor is 0 (gate disabled).
    function canSettle(address publisher) external view returns (bool);

    /// @notice Per-batch reputation update. Called by Settlement after a
    ///         batch has been processed, with the count of claims that
    ///         settled vs were rejected. msg.sender must be the wired
    ///         settlement; reverts otherwise.
    function recordSettlement(
        address publisher,
        uint256 campaignId,
        uint256 settled,
        uint256 rejected
    ) external;
}
