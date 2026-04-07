// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title DatumTimelock
/// @notice Standalone 48-hour timelock for admin changes on DATUM contracts.
///         Owner proposes a call (target + calldata), waits 48h, then anyone can execute.
///         Contracts whose ownership is transferred to this timelock gain 48h delay protection.
contract DatumTimelock {
    address public owner;
    address public pendingOwner;

    uint256 public constant TIMELOCK_DELAY = 172800; // 48 hours in seconds

    address public pendingTarget;
    bytes public pendingData;
    uint256 public pendingTimestamp;

    event ChangeProposed(address indexed target, bytes data, uint256 effectiveTime);
    event ChangeExecuted(address indexed target, bytes data);
    event ChangeCancelled(address indexed target);

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function propose(address target, bytes calldata data) external onlyOwner {
        require(target != address(0), "E00");
        require(data.length >= 4, "E36");
        require(pendingTarget == address(0), "E35");
        pendingTarget = target;
        pendingData = data;
        pendingTimestamp = block.timestamp;
        emit ChangeProposed(target, data, block.timestamp + TIMELOCK_DELAY);
    }

    function execute() external {
        require(pendingTarget != address(0), "E36");
        require(block.timestamp >= pendingTimestamp + TIMELOCK_DELAY, "E37");

        address target = pendingTarget;
        bytes memory data = pendingData;

        pendingTarget = address(0);
        pendingData = "";
        pendingTimestamp = 0;

        (bool ok,) = target.call(data);
        require(ok, "E02");

        emit ChangeExecuted(target, data);
    }

    function cancel() external onlyOwner {
        require(pendingTarget != address(0), "E35");
        address target = pendingTarget;
        pendingTarget = address(0);
        pendingData = "";
        pendingTimestamp = 0;
        emit ChangeCancelled(target);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
