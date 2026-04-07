// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumSettlementRateLimiter
/// @notice BM-5: Per-publisher settlement rate limiter interface.
interface IDatumSettlementRateLimiter {
    /// @notice Check whether a publisher can settle `impressionCount` more impressions
    ///         in the current window. If allowed, increment their window counter.
    /// @param publisher The publisher address.
    /// @param impressionCount Number of impressions in this claim.
    /// @return allowed True if within limit (counter incremented); false if limit exceeded.
    function checkAndIncrement(address publisher, uint256 impressionCount) external returns (bool allowed);
}
