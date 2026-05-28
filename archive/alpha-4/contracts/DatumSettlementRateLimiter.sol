// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";

/// @title  DatumSettlementRateLimiter
/// @notice BM-5 per-publisher window-based rate limiter. Caps view events a
///         single publisher can settle per window so a compromised publisher
///         cannot drain a campaign in a single block. Carved back out of
///         DatumSettlement for EIP-170; was an alpha-3 satellite.
///
/// @dev    Settlement is the sole writer via `tryConsume`. The atomic
///         check-and-increment replaces the inline pattern that previously
///         read the counter, compared against the cap, then wrote back.
///
/// @dev    `rlWindowBlocks` is lock-once after first non-zero set
///         (per-publisher cap remains tunable). Shifting the window size
///         mid-flight would either invalidate in-flight publisher windows
///         (DoS) or, if the new size divides the old, re-open an already
///         used window for double-use.
contract DatumSettlementRateLimiter is IDatumSettlementRateLimiter, DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    address public settlement;
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    uint256 public constant MIN_RL_WINDOW_SIZE = 10;

    /// @notice Blocks per window. Lock-once after first non-zero set.
    uint256 public rlWindowBlocks;

    /// @notice Max view events per publisher per window.
    uint256 public rlMaxEventsPerWindow;

    /// @dev publisher => windowId => cumulative view events settled in that window
    mapping(address => mapping(uint256 => uint256)) public publisherWindowEvents;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event RateLimitsUpdated(uint256 windowBlocks, uint256 maxEventsPerWindow);
    event SettlementSet(address indexed settlement);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error OnlySettlement();
    error LockedAlready();
    error WindowFrozen();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = addr;
        emit SettlementSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (settlement == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────

    function setRateLimits(uint256 windowBlocks, uint256 maxEventsPerWindow) external onlyOwner whenNotFrozen {
        if (windowBlocks < MIN_RL_WINDOW_SIZE) revert E11();
        if (maxEventsPerWindow == 0) revert E11();
        if (rlWindowBlocks != 0 && windowBlocks != rlWindowBlocks) revert WindowFrozen();
        rlWindowBlocks = windowBlocks;
        rlMaxEventsPerWindow = maxEventsPerWindow;
        emit RateLimitsUpdated(windowBlocks, maxEventsPerWindow);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry point
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumSettlementRateLimiter
    function tryConsume(address publisher, uint256 events) external returns (bool) {
        if (msg.sender != settlement) revert OnlySettlement();
        if (rlWindowBlocks == 0) return true; // limiter disabled
        if (events == 0) return true;
        uint256 windowId = block.number / rlWindowBlocks;
        uint256 current = publisherWindowEvents[publisher][windowId];
        if (current + events > rlMaxEventsPerWindow) return false;
        publisherWindowEvents[publisher][windowId] = current + events;
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function currentWindowUsage(address publisher)
        external
        view
        returns (uint256 windowId, uint256 events, uint256 limit)
    {
        if (rlWindowBlocks == 0) return (0, 0, 0);
        windowId = block.number / rlWindowBlocks;
        events = publisherWindowEvents[publisher][windowId];
        limit = rlMaxEventsPerWindow;
    }
}
