// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumSettlementRateLimiter
/// @notice BM-5: Per-publisher settlement rate limiter interface.
interface IDatumSettlementRateLimiter {
    /// @notice Check whether a publisher can settle `eventCount` more events
    ///         of the given `actionType` in the current window.
    ///         If allowed, increment their window counter.
    /// @param publisher   The publisher address.
    /// @param eventCount  Number of events in this claim.
    /// @param actionType  0=view, 1=click, 2=remote-action.
    /// @return allowed True if within limit (counter incremented); false if limit exceeded.
    function checkAndIncrement(
        address publisher,
        uint256 eventCount,
        uint8   actionType
    ) external returns (bool allowed);
}
