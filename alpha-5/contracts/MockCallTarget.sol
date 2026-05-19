// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test helper: accepts any call and records it for governance execute() tests.
///      Named functions (setValue) are called directly; unknown selectors hit the fallback.
contract MockCallTarget {
    bytes public lastPayload;
    uint256 public callCount;
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        lastPayload = data;
        callCount++;
        return "";
    }
}
