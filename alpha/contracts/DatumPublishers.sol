// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IDatumPublishers.sol";

/// @title DatumPublishers
/// @notice Publisher registry and take rate management.
///         Extracted from DatumCampaigns for PVM bytecode size limits (< 48 KB).
///
/// Publishers register with a take rate (30-80%) and can queue updates with a
/// time delay. DatumCampaigns reads publisher state via getPublisher() at
/// campaign creation to snapshot the take rate.
contract DatumPublishers is IDatumPublishers, ReentrancyGuard, Ownable, Pausable {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint16 public constant MIN_TAKE_RATE_BPS = 3000; // 30%
    uint16 public constant MAX_TAKE_RATE_BPS = 8000; // 80%

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    uint256 public takeRateUpdateDelayBlocks;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    mapping(address => Publisher) private _publishers;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(uint256 _takeRateUpdateDelayBlocks) Ownable(msg.sender) {
        takeRateUpdateDelayBlocks = _takeRateUpdateDelayBlocks;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // -------------------------------------------------------------------------
    // Publisher management
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPublishers
    function registerPublisher(uint16 takeRateBps) external nonReentrant whenNotPaused {
        require(!_publishers[msg.sender].registered, "Already registered");
        require(
            takeRateBps >= MIN_TAKE_RATE_BPS && takeRateBps <= MAX_TAKE_RATE_BPS,
            "Take rate out of range"
        );

        _publishers[msg.sender] = Publisher({
            addr: msg.sender,
            takeRateBps: takeRateBps,
            pendingTakeRateBps: 0,
            takeRateEffectiveBlock: 0,
            registered: true
        });

        emit PublisherRegistered(msg.sender, takeRateBps);
    }

    /// @inheritdoc IDatumPublishers
    function updateTakeRate(uint16 newTakeRateBps) external nonReentrant whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(
            newTakeRateBps >= MIN_TAKE_RATE_BPS && newTakeRateBps <= MAX_TAKE_RATE_BPS,
            "Take rate out of range"
        );

        Publisher storage pub = _publishers[msg.sender];
        pub.pendingTakeRateBps = newTakeRateBps;
        pub.takeRateEffectiveBlock = block.number + takeRateUpdateDelayBlocks;

        emit PublisherTakeRateQueued(msg.sender, newTakeRateBps, pub.takeRateEffectiveBlock);
    }

    /// @inheritdoc IDatumPublishers
    function applyTakeRateUpdate() external nonReentrant whenNotPaused {
        Publisher storage pub = _publishers[msg.sender];
        require(pub.registered, "Not registered");
        require(pub.pendingTakeRateBps != 0, "No pending update");
        require(block.number >= pub.takeRateEffectiveBlock, "Delay not elapsed");

        pub.takeRateBps = pub.pendingTakeRateBps;
        pub.pendingTakeRateBps = 0;
        pub.takeRateEffectiveBlock = 0;

        emit PublisherTakeRateApplied(msg.sender, pub.takeRateBps);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _publishers[publisher];
    }
}
