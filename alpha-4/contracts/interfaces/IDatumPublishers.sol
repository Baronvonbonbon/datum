// SPDX-License-Identifier: GPL-3.0-or-later
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
    /// @notice R-L2: Emitted when a publisher cancels a queued take-rate update.
    event PublisherTakeRateCancelled(address indexed publisher, uint16 cancelledTakeRateBps);
    event RelaySignerUpdated(address indexed publisher, address indexed signer);
    event ProfileUpdated(address indexed publisher, bytes32 hash);

    function registerPublisher(uint16 takeRateBps) external;
    function updateTakeRate(uint16 newTakeRateBps) external;
    function applyTakeRateUpdate() external;

    function getPublisher(address publisher) external view returns (Publisher memory);
    function isRegisteredWithRate(address publisher) external view returns (bool, uint16);
    function takeRateUpdateDelayBlocks() external view returns (uint256);
    function DEFAULT_TAKE_RATE_BPS() external view returns (uint16);

    // S12: Global blocklist
    function isBlocked(address addr) external view returns (bool);

    // S12: Per-publisher allowlist
    function allowlistEnabled(address publisher) external view returns (bool);
    function isAllowedAdvertiser(address publisher, address advertiser) external view returns (bool);

    // Publisher profile (hot key + metadata hash)
    function relaySigner(address publisher) external view returns (address);
    function profileHash(address publisher) external view returns (bytes32);
    function setRelaySigner(address signer) external;
    function setProfile(bytes32 hash) external;
}
