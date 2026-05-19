// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumSettlementRateLimiter
/// @notice Settlement-facing surface for the BM-5 per-publisher rate limiter.
///         Window-based cap: `windowId = block.number / rlWindowBlocks`;
///         per-publisher view-event counter is capped at `rlMaxEventsPerWindow`
///         per window. Carved back out of DatumSettlement for EIP-170.
interface IDatumSettlementRateLimiter {
    /// @notice Atomic check-and-increment: returns true if accepting `events`
    ///         for `publisher` in the current window would stay under the
    ///         per-window cap (state advances), false if it would exceed
    ///         (state unchanged). msg.sender must be the wired settlement.
    ///
    ///         When `rlWindowBlocks == 0` (limiter disabled) always returns
    ///         true and writes nothing -- the caller should treat the limiter
    ///         pointer as "feature off" until a window is set.
    function tryConsume(address publisher, uint256 events) external returns (bool);
}
