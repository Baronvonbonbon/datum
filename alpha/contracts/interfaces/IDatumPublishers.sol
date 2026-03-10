// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumPublishers
/// @notice Interface for DATUM publisher registry and take rate management.
///         Extracted from IDatumCampaigns for PVM bytecode size limits.
interface IDatumPublishers {
    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct Publisher {
        address addr;
        uint16 takeRateBps;           // Current take rate (basis points, 3000-8000)
        uint16 pendingTakeRateBps;    // Queued rate update
        uint256 takeRateEffectiveBlock; // Block at which pending rate becomes current
        uint256 categoryBitmask;      // Bitmask of allowed ad categories (bits 1-26)
        bool registered;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event PublisherRegistered(address indexed publisher, uint16 takeRateBps);
    event PublisherTakeRateQueued(address indexed publisher, uint16 newTakeRateBps, uint256 effectiveBlock);
    event PublisherTakeRateApplied(address indexed publisher, uint16 newTakeRateBps);
    event CategoriesUpdated(address indexed publisher, uint256 bitmask);

    // -------------------------------------------------------------------------
    // Publisher management
    // -------------------------------------------------------------------------

    /// @notice Register as a publisher with an initial take rate
    /// @param takeRateBps Publisher's take rate in basis points (3000-8000)
    function registerPublisher(uint16 takeRateBps) external;

    /// @notice Queue a take rate update; takes effect after delay (in blocks)
    /// @param newTakeRateBps New take rate in basis points (3000-8000)
    function updateTakeRate(uint16 newTakeRateBps) external;

    /// @notice Apply a queued take rate update if the delay has elapsed
    function applyTakeRateUpdate() external;

    /// @notice Set category bitmask for ad matching (bits 1-26)
    /// @param bitmask Bitfield of allowed categories
    function setCategories(uint256 bitmask) external;

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getPublisher(address publisher) external view returns (Publisher memory);
    function getCategories(address publisher) external view returns (uint256);
    function takeRateUpdateDelayBlocks() external view returns (uint256);
    function DEFAULT_TAKE_RATE_BPS() external view returns (uint16);
}
