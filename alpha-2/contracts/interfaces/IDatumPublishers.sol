// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumPublishers
/// @notice Interface for DATUM publisher registry and take rate management.
interface IDatumPublishers {
    struct Publisher {
        address addr;
        uint16 takeRateBps;
        uint16 pendingTakeRateBps;
        uint256 takeRateEffectiveBlock;
        uint256 categoryBitmask;
        bool registered;
    }

    event PublisherRegistered(address indexed publisher, uint16 takeRateBps);
    event PublisherTakeRateQueued(address indexed publisher, uint16 newTakeRateBps, uint256 effectiveBlock);
    event PublisherTakeRateApplied(address indexed publisher, uint16 newTakeRateBps);
    event CategoriesUpdated(address indexed publisher, uint256 bitmask);

    function registerPublisher(uint16 takeRateBps) external;
    function updateTakeRate(uint16 newTakeRateBps) external;
    function applyTakeRateUpdate() external;
    function setCategories(uint256 bitmask) external;

    function getPublisher(address publisher) external view returns (Publisher memory);
    function getCategories(address publisher) external view returns (uint256);
    function takeRateUpdateDelayBlocks() external view returns (uint256);
    function DEFAULT_TAKE_RATE_BPS() external view returns (uint16);
}
