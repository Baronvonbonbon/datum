// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";

/// @title DatumSettlementRateLimiter
/// @notice BM-5: Window-based per-publisher event rate limiter.
///
///         Divides time into windows of `windowBlocks` blocks each.
///         Tracks cumulative events settled per publisher per window.
///         Rate limiting applies to view claims (actionType=0) only — click and
///         remote-action claims have their own fraud mechanisms.
///
///         Called by DatumSettlement before processing each claim; returns false
///         if the publisher would exceed their per-window quota, causing the claim
///         to be rejected with reason code 14.
///
///         Design choices:
///         - Window ID = block.number / windowBlocks (integer division resets each window).
///         - No storage cleanup needed — stale windows naturally become unreachable.
///         - Optional in Settlement: address(0) = disabled (zero extra gas for existing claims).
///         - No pause check: rate limiting should work regardless of protocol pause state.
contract DatumSettlementRateLimiter is IDatumSettlementRateLimiter, Ownable2Step {
    /// @notice Only this address may call checkAndIncrement (set to the Settlement contract).
    address public settlement;

    /// @notice AUDIT-030: Minimum window size to prevent DOS via near-zero windowBlocks.
    uint256 public constant MIN_WINDOW_SIZE = 10;

    /// @notice Number of blocks per rate-limit window. ~100 blocks ≈ 10 min on Paseo (6s/block).
    uint256 public windowBlocks;

    /// @notice Maximum events a single publisher may settle per window (view claims only).
    uint256 public maxPublisherEventsPerWindow;

    /// @dev publisher => windowId => cumulative events settled in that window
    mapping(address => mapping(uint256 => uint256)) public publisherWindowEvents;

    event LimitsUpdated(uint256 windowBlocks, uint256 maxPublisherEventsPerWindow);

    constructor(uint256 _windowBlocks, uint256 _maxPublisherEventsPerWindow) Ownable(msg.sender) {
        require(_windowBlocks >= MIN_WINDOW_SIZE, "E11"); // AUDIT-030
        require(_maxPublisherEventsPerWindow > 0, "E11");
        windowBlocks = _windowBlocks;
        maxPublisherEventsPerWindow = _maxPublisherEventsPerWindow;
        emit LimitsUpdated(_windowBlocks, _maxPublisherEventsPerWindow);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Update window size and per-publisher event cap.
    function setLimits(uint256 _windowBlocks, uint256 _maxPublisherEventsPerWindow) external onlyOwner {
        require(_windowBlocks >= MIN_WINDOW_SIZE, "E11"); // AUDIT-030
        require(_maxPublisherEventsPerWindow > 0, "E11");
        windowBlocks = _windowBlocks;
        maxPublisherEventsPerWindow = _maxPublisherEventsPerWindow;
        emit LimitsUpdated(_windowBlocks, _maxPublisherEventsPerWindow);
    }

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }

    // -------------------------------------------------------------------------
    // Rate limiting
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlementRateLimiter
    function checkAndIncrement(
        address publisher,
        uint256 eventCount,
        uint8   actionType
    ) external override returns (bool) {
        require(msg.sender == settlement, "E18");
        // Rate limiting applies to view claims only; click/action claims are controlled by other mechanisms
        if (actionType != 0) return true;

        uint256 windowId = block.number / windowBlocks;
        uint256 current = publisherWindowEvents[publisher][windowId];
        if (current + eventCount > maxPublisherEventsPerWindow) {
            return false;
        }
        publisherWindowEvents[publisher][windowId] = current + eventCount;
        return true;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the current window's view-event usage for a publisher.
    /// @return windowId   The current window identifier.
    /// @return events     Events settled by this publisher so far this window.
    /// @return limit      The per-window event cap.
    function currentWindowUsage(address publisher)
        external
        view
        returns (uint256 windowId, uint256 events, uint256 limit)
    {
        windowId = block.number / windowBlocks;
        events = publisherWindowEvents[publisher][windowId];
        limit = maxPublisherEventsPerWindow;
    }
}
