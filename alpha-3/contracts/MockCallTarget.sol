// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test helper: accepts any call and records it for governance execute() tests.
contract MockCallTarget {
    bytes public lastPayload;
    uint256 public callCount;

    fallback(bytes calldata data) external returns (bytes memory) {
        lastPayload = data;
        callCount++;
        return "";
    }
}
