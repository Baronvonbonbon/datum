// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IDatumStakeRoot {
    function latestEpoch() external view returns (uint256);
    function rootAt(uint256 epoch) external view returns (bytes32);
    function isRecent(bytes32 root) external view returns (bool);
}
