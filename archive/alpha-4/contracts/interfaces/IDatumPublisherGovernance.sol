// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumPublisherGovernance
/// @notice FP-3: Conviction-weighted fraud proposals targeting publishers.
///         Any participant can stake DOT to vote aye/nay on a publisher fraud
///         proposal. If aye wins (> 50% weighted, >= quorum), the publisher's
///         stake is slashed and a portion flows to ChallengeBonds.
interface IDatumPublisherGovernance {
    struct Proposal {
        address publisher;
        bytes32 evidenceHash;
        uint256 createdBlock;
        bool resolved;
        uint256 ayeWeighted;
        uint256 nayWeighted;
        uint256 firstNayBlock;   // used for grace period measurement
        address proposer;        // G-M5: bond owner
        uint256 bond;             // G-M5: locked at propose, refunded if quorum reached
    }

    struct Vote {
        uint8 direction;          // 1 = aye, 2 = nay, 0 = none
        uint256 lockAmount;
        uint8 conviction;
        uint256 lockedUntilBlock;
    }

    event ProposalCreated(uint256 indexed proposalId, address indexed publisher, bytes32 evidenceHash);
    /// @notice G-M5: bond locked at propose / refunded on quorum / slashed otherwise.
    event ProposeBondLocked(uint256 indexed proposalId, address indexed proposer, uint256 amount);
    event ProposeBondQueued(address indexed recipient, uint256 amount, bool refunded);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool aye, uint256 amount, uint8 conviction);
    event VoteWithdrawn(uint256 indexed proposalId, address indexed voter, uint256 amount);
    /// @notice AUDIT-007: Emitted when a prior vote deposit is refunded during re-vote.
    event VoteRefunded(uint256 indexed proposalId, address indexed voter, uint256 amount);
    event ProposalResolved(uint256 indexed proposalId, address indexed publisher, bool fraudUpfield, uint256 slashAmount);

    // ── Actions ────────────────────────────────────────────────────────────────

    /// @notice Submit a fraud proposal for a publisher. Payable — must equal proposeBond (G-M5).
    /// @param publisher     Publisher address to accuse.
    /// @param evidenceHash  Off-chain evidence hash (IPFS CID or similar).
    function propose(address publisher, bytes32 evidenceHash) external payable;

    /// @notice Cast or update a vote on a proposal. Payable — DOT is locked.
    /// @param proposalId  Proposal to vote on.
    /// @param aye         True = fraud upheld, false = nay.
    /// @param conviction  Conviction level 0-8.
    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable;

    /// @notice Withdraw a vote after its lockup period has elapsed.
    /// @param proposalId  Proposal the vote belongs to.
    function withdrawVote(uint256 proposalId) external;

    /// @notice Resolve a proposal once quorum and grace period conditions are met.
    /// @param proposalId  Proposal to resolve.
    function resolve(uint256 proposalId) external;

    // ── Views ──────────────────────────────────────────────────────────────────

    function proposals(uint256 proposalId) external view returns (Proposal memory);
    function getVote(uint256 proposalId, address voter) external view returns (Vote memory);
    function nextProposalId() external view returns (uint256);

    function quorum() external view returns (uint256);
    function slashBps() external view returns (uint256);         // portion of publisher stake to slash (bps)
    function bondBonusBps() external view returns (uint256);     // portion of slash that goes to challenge bonds pool (bps)
    function minGraceBlocks() external view returns (uint256);   // min blocks after nay appears before resolution
    function proposeBond() external view returns (uint256);      // G-M5: required bond per proposal
}
