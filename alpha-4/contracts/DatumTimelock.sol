// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";

/// @title DatumTimelock
/// @notice 48-hour timelock for admin changes on DATUM contracts.
///         C-6: Supports multiple concurrent proposals keyed by proposalId.
///         proposalId = keccak256(target, data, salt).
///         Max MAX_CONCURRENT proposals pending at once.
contract DatumTimelock is ReentrancyGuard, DatumOwnable {
    uint256 public constant TIMELOCK_DELAY = 172800;    // 48 hours in seconds
    /// @notice AUDIT-029: Proposals expire after 7 days post-delay to prevent stale execution.
    uint256 public constant PROPOSAL_TIMEOUT = 604800;  // 7 days in seconds
    /// @notice C-6: Cap concurrent proposals to bound storage growth.
    uint256 public constant MAX_CONCURRENT = 10;

    struct Proposal {
        address target;
        bytes data;
        uint256 timestamp;
        bool executed;
        bool cancelled;
    }

    mapping(bytes32 => Proposal) public proposals;
    uint256 public pendingCount;

    event ChangeProposed(bytes32 indexed proposalId, address indexed target, bytes data, uint256 effectiveTime);
    event ChangeExecuted(bytes32 indexed proposalId, address indexed target, bytes data);
    event ChangeCancelled(bytes32 indexed proposalId, address indexed target);

    /// @notice Compute the proposal ID from its parameters.
    function hashProposal(address target, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, data, salt));
    }

    /// @notice Propose a timelocked call. salt allows multiple proposals with same target+data.
    function propose(address target, bytes calldata data, bytes32 salt) external onlyOwner returns (bytes32 proposalId) {
        require(target != address(0), "E00");
        require(data.length >= 4, "E36");
        require(pendingCount < MAX_CONCURRENT, "E35");

        proposalId = hashProposal(target, data, salt);
        require(proposals[proposalId].timestamp == 0, "E35");

        proposals[proposalId] = Proposal({
            target: target,
            data: data,
            timestamp: block.timestamp,
            executed: false,
            cancelled: false
        });
        pendingCount++;

        emit ChangeProposed(proposalId, target, data, block.timestamp + TIMELOCK_DELAY);
    }

    /// @notice Execute a matured proposal.
    function execute(bytes32 proposalId) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.timestamp != 0, "E36");
        require(!p.executed, "E36");
        require(!p.cancelled, "E36");
        require(block.timestamp >= p.timestamp + TIMELOCK_DELAY, "E37");
        // AUDIT-029: Reject stale proposals
        require(block.timestamp <= p.timestamp + TIMELOCK_DELAY + PROPOSAL_TIMEOUT, "E37");

        p.executed = true;
        pendingCount--;

        (bool ok,) = p.target.call(p.data);
        require(ok, "E02");

        emit ChangeExecuted(proposalId, p.target, p.data);
    }

    /// @notice Cancel a pending proposal.
    function cancel(bytes32 proposalId) external onlyOwner {
        Proposal storage p = proposals[proposalId];
        require(p.timestamp != 0, "E36");
        require(!p.executed, "E36");
        require(!p.cancelled, "E36");

        p.cancelled = true;
        pendingCount--;

        emit ChangeCancelled(proposalId, p.target);
    }

    /// @notice Reject stray native deposits (G-I1). `execute` calls
    ///         `target.call(data)` without forwarding value, so receive() has
    ///         no real consumer; treat unsolicited transfers as a misconfiguration.
    receive() external payable { revert("E03"); }
}
