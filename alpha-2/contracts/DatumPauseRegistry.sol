// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DatumPauseRegistry
/// @notice Global emergency pause circuit breaker. Single bool, single owner.
///         All DATUM contracts check paused() via staticcall before critical operations.
contract DatumPauseRegistry {
    address public owner;
    bool public paused;

    event Paused(address indexed by);
    event Unpaused(address indexed by);

    constructor() {
        owner = msg.sender;
    }

    function pause() external {
        require(msg.sender == owner, "E18");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        require(msg.sender == owner, "E18");
        paused = false;
        emit Unpaused(msg.sender);
    }
}
