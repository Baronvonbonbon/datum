// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumSettlementRateLimiter.sol";

/// @title DatumSettlementRateLimiter
/// @notice BM-5: Window-based per-publisher impression rate limiter.
///
///         Divides time into windows of `windowBlocks` blocks each.
///         Tracks cumulative impressions settled per publisher per window.
///         Called by DatumSettlement before processing each claim; returns false
///         if the publisher would exceed their per-window quota, causing the claim
///         to be rejected with reason code 14.
///
///         Design choices:
///         - Window ID = block.number / windowBlocks (integer division resets each window).
///         - No storage cleanup needed — stale windows naturally become unreachable.
///         - Optional in Settlement: address(0) = disabled (zero extra gas for existing claims).
///         - No pause check: rate limiting should work regardless of protocol pause state.
contract DatumSettlementRateLimiter is IDatumSettlementRateLimiter {
    address public owner;
    address public pendingOwner;

    /// @notice Number of blocks per rate-limit window. ~100 blocks ≈ 10 min on Paseo (6s/block).
    uint256 public windowBlocks;

    /// @notice Maximum impressions a single publisher may settle per window.
    uint256 public maxPublisherImpressionsPerWindow;

    /// @dev publisher => windowId => cumulative impressions settled in that window
    mapping(address => mapping(uint256 => uint256)) public publisherWindowImpressions;

    event LimitsUpdated(uint256 windowBlocks, uint256 maxPublisherImpressionsPerWindow);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(uint256 _windowBlocks, uint256 _maxPublisherImpressionsPerWindow) {
        require(_windowBlocks > 0, "E11");
        require(_maxPublisherImpressionsPerWindow > 0, "E11");
        owner = msg.sender;
        windowBlocks = _windowBlocks;
        maxPublisherImpressionsPerWindow = _maxPublisherImpressionsPerWindow;
        emit LimitsUpdated(_windowBlocks, _maxPublisherImpressionsPerWindow);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Update window size and per-publisher impression cap.
    function setLimits(uint256 _windowBlocks, uint256 _maxPublisherImpressionsPerWindow) external {
        require(msg.sender == owner, "E18");
        require(_windowBlocks > 0, "E11");
        require(_maxPublisherImpressionsPerWindow > 0, "E11");
        windowBlocks = _windowBlocks;
        maxPublisherImpressionsPerWindow = _maxPublisherImpressionsPerWindow;
        emit LimitsUpdated(_windowBlocks, _maxPublisherImpressionsPerWindow);
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------------------
    // Rate limiting
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlementRateLimiter
    function checkAndIncrement(address publisher, uint256 impressionCount) external override returns (bool) {
        uint256 windowId = block.number / windowBlocks;
        uint256 current = publisherWindowImpressions[publisher][windowId];
        if (current + impressionCount > maxPublisherImpressionsPerWindow) {
            return false;
        }
        publisherWindowImpressions[publisher][windowId] = current + impressionCount;
        return true;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the current window's usage for a publisher.
    /// @return windowId    The current window identifier.
    /// @return impressions Impressions settled by this publisher so far this window.
    /// @return limit       The per-window impression cap.
    function currentWindowUsage(address publisher)
        external
        view
        returns (uint256 windowId, uint256 impressions, uint256 limit)
    {
        windowId = block.number / windowBlocks;
        impressions = publisherWindowImpressions[publisher][windowId];
        limit = maxPublisherImpressionsPerWindow;
    }
}
