// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumTargetingRegistry.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumTargetingRegistry
/// @notice Tag-based publisher targeting. Publishers declare bytes32 tag hashes
///         (e.g., keccak256("topic:defi"), keccak256("locale:en-US")).
///         Campaigns specify required tags; matching is AND logic.
///         Replaces the fixed uint256 categoryBitmask on DatumPublishers.
contract DatumTargetingRegistry is IDatumTargetingRegistry, Ownable2Step {
    uint8 public constant MAX_PUBLISHER_TAGS = 32;
    uint8 public constant MAX_CAMPAIGN_TAGS = 8;

    IDatumPublishers public publishers;
    IDatumPauseRegistry public pauseRegistry;

    // Publisher address → array of tag hashes
    mapping(address => bytes32[]) private _publisherTags;
    // Publisher address → tag hash → bool (for O(1) lookup in hasAllTags)
    mapping(address => mapping(bytes32 => bool)) private _publisherTagSet;

    constructor(address _publishers, address _pauseRegistry) Ownable(msg.sender) {
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        publishers = IDatumPublishers(_publishers);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.paused(), "P");
        _;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setPublishers(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        publishers = IDatumPublishers(addr);
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
    // Publisher tag management
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTargetingRegistry
    function setTags(bytes32[] calldata tagHashes) external whenNotPaused {
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(msg.sender);
        require(pub.registered, "Not registered");
        require(tagHashes.length <= MAX_PUBLISHER_TAGS, "E65");

        // Clear old tags from the set
        bytes32[] storage oldTags = _publisherTags[msg.sender];
        for (uint256 i = 0; i < oldTags.length; i++) {
            _publisherTagSet[msg.sender][oldTags[i]] = false;
        }

        // Set new tags
        delete _publisherTags[msg.sender];
        for (uint256 i = 0; i < tagHashes.length; i++) {
            require(tagHashes[i] != bytes32(0), "E00");
            _publisherTags[msg.sender].push(tagHashes[i]);
            _publisherTagSet[msg.sender][tagHashes[i]] = true;
        }

        emit TagsUpdated(msg.sender, tagHashes);
    }

    /// @inheritdoc IDatumTargetingRegistry
    function getTags(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    /// @inheritdoc IDatumTargetingRegistry
    function hasAllTags(
        address publisher,
        bytes32[] calldata requiredTags
    ) external view returns (bool) {
        if (requiredTags.length == 0) return true;
        require(requiredTags.length <= MAX_CAMPAIGN_TAGS, "E66");

        for (uint256 i = 0; i < requiredTags.length; i++) {
            if (!_publisherTagSet[publisher][requiredTags[i]]) return false;
        }
        return true;
    }
}
