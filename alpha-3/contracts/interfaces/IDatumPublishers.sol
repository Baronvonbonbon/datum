// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumPublishers
/// @notice Interface for DATUM publisher registry and take rate management.
interface IDatumPublishers {
    struct Publisher {
        address addr;
        uint16 takeRateBps;
        uint16 pendingTakeRateBps;
        uint256 takeRateEffectiveBlock;
        bool registered;
    }

    event PublisherRegistered(address indexed publisher, uint16 takeRateBps);
    event PublisherTakeRateQueued(address indexed publisher, uint16 newTakeRateBps, uint256 effectiveBlock);
    event PublisherTakeRateApplied(address indexed publisher, uint16 newTakeRateBps);

    function registerPublisher(uint16 takeRateBps) external;
    function updateTakeRate(uint16 newTakeRateBps) external;
    function applyTakeRateUpdate() external;

    function getPublisher(address publisher) external view returns (Publisher memory);
    function takeRateUpdateDelayBlocks() external view returns (uint256);
    function DEFAULT_TAKE_RATE_BPS() external view returns (uint16);

    // S12: Global blocklist
    function isBlocked(address addr) external view returns (bool);

    // S12: Per-publisher allowlist
    function allowlistEnabled(address publisher) external view returns (bool);
    function isAllowedAdvertiser(address publisher, address advertiser) external view returns (bool);
}
