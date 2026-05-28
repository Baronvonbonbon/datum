// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumNullifierRegistry
/// @notice Interface for the FP-5 per-user per-campaign per-window nullifier registry.
///         Prevents a user from claiming the same campaign twice in the same window.
///
///         Nullifier derivation (in impression.circom):
///           nullifier = Poseidon(userSecret, campaignId, windowId)
///           windowId  = floor(blockNumber / windowBlocks)
///
///         On-chain the nullifier is treated as an opaque bytes32. The NullifierRegistry
///         simply tracks (campaignId → nullifier → bool) and reverts on duplicate.
interface IDatumNullifierRegistry {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event NullifierSubmitted(uint256 indexed campaignId, bytes32 indexed nullifier);

    // -------------------------------------------------------------------------
    // Settlement-only
    // -------------------------------------------------------------------------

    /// @notice Mark a nullifier as used for a campaign. Reverts with E73 if already used.
    ///         Only callable by the registered settlement contract.
    /// @param nullifier  bytes32 Poseidon hash from the ZK circuit
    /// @param campaignId Campaign the claim belongs to
    function submitNullifier(bytes32 nullifier, uint256 campaignId) external;

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns true if the nullifier has already been submitted for this campaign.
    function isUsed(uint256 campaignId, bytes32 nullifier) external view returns (bool);

    /// @notice Number of blocks per nullifier window (used by relay bot to compute windowId).
    function windowBlocks() external view returns (uint256);
}
