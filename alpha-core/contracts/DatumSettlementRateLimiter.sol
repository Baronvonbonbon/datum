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
    // Aggregate circuit breaker (protocol-wide). Bounds total view-settlement
    // volume across ALL publishers per window so a pricing/settlement bug or
    // exploit cannot drain budgets faster than a guardian can react. On breach
    // the breaker LATCHES open (all view settles reject) until a deliberate
    // reset by the breaker operator or owner — buying time for an incident
    // response (pause / investigate / fix). 0 = disabled (default). Keyed off
    // the same `rlWindowBlocks` as the per-publisher limiter.
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Max view events ALL publishers combined may settle per window.
    uint256 public maxGlobalEventsPerWindow;
    /// @dev windowId => cumulative view events settled protocol-wide.
    mapping(uint256 => uint256) public globalWindowEvents;
    /// @notice Latched true on a window-cap breach; blocks view settles until reset.
    bool public globalBreakerTripped;
    /// @notice Fast-reset authority (a guardian/ops key). Owner can also reset.
    address public breakerOperator;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event RateLimitsUpdated(uint256 windowBlocks, uint256 maxEventsPerWindow);
    event SettlementSet(address indexed settlement);
    event PlumbingLocked();
    event GlobalRateLimitUpdated(uint256 maxGlobalEventsPerWindow);
    event GlobalBreakerTripped(uint256 indexed windowId, uint256 windowEvents, uint256 cap);
    event GlobalBreakerReset(address indexed by);
    event BreakerOperatorSet(address indexed operator);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error OnlySettlement();
    error LockedAlready();
    error WindowFrozen();
    error NotBreakerAuthority();

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

    /// @notice Set the protocol-wide per-window view-event ceiling (0 = disabled).
    ///         Set generously (≫ expected volume) so it only trips on anomalies.
    ///         Requires rlWindowBlocks to be set (shares the window).
    function setGlobalRateLimit(uint256 maxGlobal) external onlyOwner whenNotFrozen {
        maxGlobalEventsPerWindow = maxGlobal;
        emit GlobalRateLimitUpdated(maxGlobal);
    }

    /// @notice Designate a fast-reset operator (e.g. a pause guardian). Owner can
    ///         always reset too; owner is the Timelock post-deploy (48h), so a
    ///         dedicated operator gives guardian-speed recovery from a false trip.
    function setBreakerOperator(address op) external onlyOwner {
        breakerOperator = op;
        emit BreakerOperatorSet(op);
    }

    /// @notice Clear a tripped breaker (deliberate re-engage after investigation).
    function resetGlobalBreaker() external {
        if (msg.sender != owner() && msg.sender != breakerOperator) revert NotBreakerAuthority();
        globalBreakerTripped = false;
        emit GlobalBreakerReset(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry point
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumSettlementRateLimiter
    function tryConsume(address publisher, uint256 events) external returns (bool) {
        if (msg.sender != settlement) revert OnlySettlement();
        // Aggregate breaker is checked first: once latched, ALL view settles
        // reject until a deliberate reset, regardless of per-publisher state.
        if (globalBreakerTripped) return false;
        if (rlWindowBlocks == 0) return true; // limiter disabled
        if (events == 0) return true;
        uint256 windowId = block.number / rlWindowBlocks;

        // Per-publisher cap (BM-5).
        uint256 current = publisherWindowEvents[publisher][windowId];
        if (current + events > rlMaxEventsPerWindow) return false;

        // Protocol-wide aggregate cap → trip + latch the breaker on breach.
        if (maxGlobalEventsPerWindow != 0) {
            uint256 gw = globalWindowEvents[windowId] + events;
            if (gw > maxGlobalEventsPerWindow) {
                globalBreakerTripped = true;
                emit GlobalBreakerTripped(windowId, gw, maxGlobalEventsPerWindow);
                return false;
            }
            globalWindowEvents[windowId] = gw;
        }

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

    /// @notice Protocol-wide breaker state for the current window.
    function globalWindowUsage()
        external
        view
        returns (uint256 windowId, uint256 events, uint256 cap, bool tripped)
    {
        if (rlWindowBlocks != 0) windowId = block.number / rlWindowBlocks;
        events = globalWindowEvents[windowId];
        cap = maxGlobalEventsPerWindow;
        tripped = globalBreakerTripped;
    }
}
