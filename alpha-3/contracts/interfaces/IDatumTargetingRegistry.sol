// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumTargetingRegistry
/// @notice Interface for tag-based publisher targeting.
///         Replaces the uint256 categoryBitmask with flexible bytes32 tag hashes.
///         Tags are keccak256(abi.encodePacked(dimension, ":", value)).
interface IDatumTargetingRegistry {
    event TagsUpdated(address indexed publisher, bytes32[] tagHashes);

    /// @notice Publisher sets their supported tags (max 32). Replaces all previous tags.
    function setTags(bytes32[] calldata tagHashes) external;

    /// @notice Returns all tags for a publisher.
    function getTags(address publisher) external view returns (bytes32[] memory);

    /// @notice Returns true if publisher has ALL of the required tags (AND logic).
    ///         Returns true if requiredTags is empty.
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool);
}
