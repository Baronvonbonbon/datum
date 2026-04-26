// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumTimelock
/// @notice Standalone 48-hour timelock for admin changes on DATUM contracts.
///         Owner proposes a call (target + calldata), waits 48h, then anyone can execute.
///         Contracts whose ownership is transferred to this timelock gain 48h delay protection.
contract DatumTimelock is ReentrancyGuard, Ownable2Step {
    uint256 public constant TIMELOCK_DELAY = 172800;    // 48 hours in seconds
    /// @notice AUDIT-029: Proposals expire after 7 days post-delay to prevent stale execution.
    uint256 public constant PROPOSAL_TIMEOUT = 604800;  // 7 days in seconds

    address public pendingTarget;
    bytes public pendingData;
    uint256 public pendingTimestamp;

    event ChangeProposed(address indexed target, bytes data, uint256 effectiveTime);
    event ChangeExecuted(address indexed target, bytes data);
    event ChangeCancelled(address indexed target);

    constructor() Ownable(msg.sender) {}

    function propose(address target, bytes calldata data) external onlyOwner {
        require(target != address(0), "E00");
        require(data.length >= 4, "E36");
        require(pendingTarget == address(0), "E35");
        pendingTarget = target;
        pendingData = data;
        pendingTimestamp = block.timestamp;
        emit ChangeProposed(target, data, block.timestamp + TIMELOCK_DELAY);
    }

    function execute() external nonReentrant {
        require(pendingTarget != address(0), "E36");
        require(block.timestamp >= pendingTimestamp + TIMELOCK_DELAY, "E37");
        // AUDIT-029: Reject stale proposals — must execute within PROPOSAL_TIMEOUT after delay
        require(block.timestamp <= pendingTimestamp + TIMELOCK_DELAY + PROPOSAL_TIMEOUT, "E37");

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

    /// @notice Accept ETH so timelocked proposals can forward value.
    receive() external payable {}
}
