// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumPowEngine
/// @notice Minimal interface for the per-impression proof-of-work engine.
///         Carved out of DatumSettlement so PoW logic can be upgraded
///         independently via the governance router and so Settlement
///         fits under EIP-170.
interface IDatumPowEngine {
    /// @notice Global PoW enforcement flag. Read by ClaimValidator to decide
    ///         whether to require `keccak256(claimHash || powNonce) <= target`.
    function enforcePow() external view returns (bool);

    /// @notice Difficulty target for `user` at impression-batch size `eventCount`.
    ///         Returns `type(uint256).max` when PoW is disabled or `eventCount == 0`.
    function powTargetForUser(address user, uint256 eventCount) external view returns (uint256);

    /// @notice Per-batch leaky-bucket update. Settlement calls this once per
    ///         processed batch (totalling all claims' eventCounts for the
    ///         same user). Reverts if msg.sender isn't the wired settlement.
    function consumeFor(address user, uint256 eventCount) external;
}
