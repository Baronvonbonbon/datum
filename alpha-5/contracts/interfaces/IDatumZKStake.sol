// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IDatumZKStake {
    function staked(address user) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function LOCKUP_BLOCKS() external view returns (uint256);
}
