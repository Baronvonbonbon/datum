// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IDatumPublishers.sol";

/// @title DatumPublishers
/// @notice Publisher registry and take rate management. Unchanged from alpha.
contract DatumPublishers is IDatumPublishers, ReentrancyGuard, Ownable, Pausable {
    uint16 public constant MIN_TAKE_RATE_BPS = 3000;
    uint16 public constant MAX_TAKE_RATE_BPS = 8000;
    uint16 public constant DEFAULT_TAKE_RATE_BPS = 5000;

    uint256 public takeRateUpdateDelayBlocks;

    mapping(address => Publisher) private _publishers;

    constructor(uint256 _takeRateUpdateDelayBlocks) Ownable(msg.sender) {
        takeRateUpdateDelayBlocks = _takeRateUpdateDelayBlocks;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

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
            categoryBitmask: 0,
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

    /// @inheritdoc IDatumPublishers
    function setCategories(uint256 bitmask) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        _publishers[msg.sender].categoryBitmask = bitmask;
        emit CategoriesUpdated(msg.sender, bitmask);
    }

    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _publishers[publisher];
    }

    function getCategories(address publisher) external view returns (uint256) {
        return _publishers[publisher].categoryBitmask;
    }

    function isRegisteredWithRate(address publisher) external view returns (bool, uint16) {
        Publisher storage p = _publishers[publisher];
        return (p.registered, p.takeRateBps);
    }
}
