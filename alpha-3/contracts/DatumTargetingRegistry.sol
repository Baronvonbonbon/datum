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

    // M-2: Approved tag registry (owner-managed). If enforceTagRegistry=true,
    // setTags() rejects tags not in _approvedTags.
    bool public enforceTagRegistry;
    mapping(bytes32 => bool) public approvedTags;
    bytes32[] private _approvedTagList;
    mapping(bytes32 => uint256) private _approvedTagIndex; // 1-based index for swap-and-pop

    event TagRegistryEnforced(bool enforced);
    event TagApproved(bytes32 indexed tag);
    event TagRemoved(bytes32 indexed tag);

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

    /// @notice M-2: Enable or disable tag registry enforcement.
    function setEnforceTagRegistry(bool enforced) external onlyOwner {
        enforceTagRegistry = enforced;
        emit TagRegistryEnforced(enforced);
    }

    /// @notice M-2: Add a tag to the approved registry.
    function approveTag(bytes32 tag) external onlyOwner {
        require(tag != bytes32(0), "E00");
        require(!approvedTags[tag], "E15");
        approvedTags[tag] = true;
        _approvedTagList.push(tag);
        _approvedTagIndex[tag] = _approvedTagList.length; // 1-based
        emit TagApproved(tag);
    }

    /// @notice M-2: Remove a tag from the approved registry (swap-and-pop).
    function removeTag(bytes32 tag) external onlyOwner {
        require(approvedTags[tag], "E01");
        approvedTags[tag] = false;

        uint256 idx = _approvedTagIndex[tag] - 1; // convert to 0-based
        uint256 lastIdx = _approvedTagList.length - 1;
        if (idx != lastIdx) {
            bytes32 lastTag = _approvedTagList[lastIdx];
            _approvedTagList[idx] = lastTag;
            _approvedTagIndex[lastTag] = idx + 1;
        }
        _approvedTagList.pop();
        delete _approvedTagIndex[tag];
        emit TagRemoved(tag);
    }

    /// @notice M-2: Batch approve tags.
    function approveTags(bytes32[] calldata tags) external onlyOwner {
        for (uint256 i = 0; i < tags.length; i++) {
            require(tags[i] != bytes32(0), "E00");
            if (!approvedTags[tags[i]]) {
                approvedTags[tags[i]] = true;
                _approvedTagList.push(tags[i]);
                _approvedTagIndex[tags[i]] = _approvedTagList.length;
                emit TagApproved(tags[i]);
            }
        }
    }

    /// @notice M-2: List all approved tags.
    function listApprovedTags() external view returns (bytes32[] memory) {
        return _approvedTagList;
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
        bool enforce = enforceTagRegistry;
        for (uint256 i = 0; i < tagHashes.length; i++) {
            require(tagHashes[i] != bytes32(0), "E00");
            // M-2: Validate tag is in approved registry when enforcement is on
            if (enforce) require(approvedTags[tagHashes[i]], "E81");
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
