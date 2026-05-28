// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumParameterGovernance
/// @notice T1-B: Conviction-vote governance for FP system parameter changes.
///         Proposers post a DOT bond; voters stake DOT conviction-weighted.
///         After the voting window, passed proposals execute any target call
///         after a timelock. Bond is returned on execute; slashed on reject/cancel.
interface IDatumParameterGovernance {

    enum State { Active, Passed, Executed, Rejected, Cancelled }

    struct Proposal {
        address proposer;
        address target;
        bytes payload;       // ABI-encoded call to execute
        string description;
        uint256 startBlock;
        uint256 endBlock;    // startBlock + votingPeriodBlocks
        uint256 executeAfter;// set on pass: endBlock + timelockBlocks
        uint256 ayeWeight;
        uint256 nayWeight;
        uint256 bond;
        State state;
    }

    struct Vote {
        bool aye;
        uint8 conviction;
        uint256 lockAmount;
        uint256 lockUntil;   // block number when vote can be withdrawn
    }

    event Proposed(uint256 indexed proposalId, address indexed proposer, address indexed target, string description);
    event Voted(uint256 indexed proposalId, address indexed voter, bool aye, uint256 amount, uint8 conviction);
    event VoteWithdrawn(uint256 indexed proposalId, address indexed voter, uint256 amount);
    event Resolved(uint256 indexed proposalId, uint8 state);
    event Executed(uint256 indexed proposalId, address target);
    event Cancelled(uint256 indexed proposalId);
    event ParamsUpdated(uint256 votingPeriod, uint256 timelock, uint256 quorum, uint256 bond);

    /// @notice Submit a parameter change proposal. msg.value must equal proposeBond.
    function propose(address target, bytes calldata payload, string calldata description)
        external payable returns (uint256 proposalId);

    /// @notice Cast or replace a vote. Payable — DOT is locked until lockUntil.
    ///         Re-voting refunds the previous deposit first.
    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable;

    /// @notice Withdraw a vote after its lockup period has elapsed.
    function withdrawVote(uint256 proposalId) external;

    /// @notice Resolve a proposal once the voting window has closed.
    ///         If ayes >= quorum and ayes > nays → Passed; else Rejected (bond slashed).
    function resolve(uint256 proposalId) external;

    /// @notice Execute a Passed proposal after timelockBlocks. Returns bond to proposer.
    function execute(uint256 proposalId) external;

    /// @notice Owner-only: cancel any Active or Passed proposal (slashes bond).
    function cancel(uint256 proposalId) external;

    // ── Admin ──────────────────────────────────────────────────────────────────
    function setParams(uint256 votingPeriod, uint256 timelock, uint256 quorum_, uint256 bond) external;

    // ── Views ──────────────────────────────────────────────────────────────────
    function proposals(uint256 proposalId) external view returns (Proposal memory);
    function getVote(uint256 proposalId, address voter) external view returns (Vote memory);
    function nextProposalId() external view returns (uint256);
    function votingPeriodBlocks() external view returns (uint256);
    function timelockBlocks() external view returns (uint256);
    function quorum() external view returns (uint256);
    function proposeBond() external view returns (uint256);
    function convictionWeight(uint8 conviction) external pure returns (uint256);
    function convictionLockup(uint8 conviction) external pure returns (uint256);
}
