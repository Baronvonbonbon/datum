// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumClickRegistry
/// @notice Tracks impression→click sessions for CPC fraud prevention.
///         The relay records a click when the extension reports one; settlement marks it
///         claimed so the same impression-click session cannot be reused.
interface IDatumClickRegistry {
    event ClickRecorded(bytes32 indexed sessionHash, address indexed user, uint256 indexed campaignId);
    event ClickClaimed(bytes32 indexed sessionHash);

    /// @notice Record a click event. Called by the relay after receiving a signed AD_CLICK.
    /// @param user          The user who clicked.
    /// @param campaignId    The campaign being clicked.
    /// @param impressionNonce The nonce from the impression claim that preceded this click.
    function recordClick(address user, uint256 campaignId, bytes32 impressionNonce) external;

    /// @notice Mark a click session as claimed. Called by Settlement after a type-1 claim settles.
    /// @param user          The user.
    /// @param campaignId    The campaign.
    /// @param impressionNonce The impression nonce that anchors this session.
    function markClaimed(address user, uint256 campaignId, bytes32 impressionNonce) external;

    /// @notice Check whether a click session exists and has not yet been claimed.
    function hasUnclaimed(address user, uint256 campaignId, bytes32 impressionNonce) external view returns (bool);

    /// @notice Compute the session hash for a given (user, campaign, impressionNonce) triple.
    function sessionHash(address user, uint256 campaignId, bytes32 impressionNonce) external pure returns (bytes32);
}
