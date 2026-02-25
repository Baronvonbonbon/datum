// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumGovernanceVoting
/// @notice Interface for DATUM governance voting, stake management, and slash rewards.
///
/// This contract holds all staked DOT and slash funds.
/// It handles: vote casting, activation/termination triggers, slash distribution,
/// stake withdrawal, and slash reward claims.
interface IDatumGovernanceVoting {
    // -------------------------------------------------------------------------
    // Enums
    // -------------------------------------------------------------------------

    enum VoteDirection { Aye, Nay }

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct VoteRecord {
        address voter;
        VoteDirection direction;
        uint256 lockAmount;       // DOT staked (planck)
        uint8 conviction;         // 0-6; multiplier = 2^conviction
        uint256 lockedUntilBlock; // Block after which stake can be withdrawn
        uint256 castAtBlock;      // Block at which vote was cast
    }

    struct CampaignVote {
        uint256 ayeTotal;           // Weighted aye votes (lock * multiplier)
        uint256 nayTotal;           // Weighted nay votes (lock * multiplier)
        uint256 uniqueReviewers;    // Count of aye voters meeting minReviewerStake
        uint256 terminationBlock;   // Block at which campaign was terminated (0 if not)
        bool activated;
        bool terminated;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event VoteCast(
        uint256 indexed campaignId,
        address indexed voter,
        VoteDirection direction,
        uint256 lockAmount,
        uint8 conviction,
        uint256 lockedUntilBlock
    );
    event CampaignActivatedByGovernance(uint256 indexed campaignId, uint256 ayeTotal);
    event CampaignTerminatedByGovernance(
        uint256 indexed campaignId,
        uint256 nayTotal,
        uint256 terminationBlock
    );
    // -------------------------------------------------------------------------
    // Voting
    // -------------------------------------------------------------------------

    function voteAye(uint256 campaignId, uint8 conviction) external payable;
    function voteNay(uint256 campaignId, uint8 conviction) external payable;

    // -------------------------------------------------------------------------
    // Rewards contract callbacks
    // -------------------------------------------------------------------------

    /// @notice Multipurpose rewards callback.
    /// action: 0=transferDOT, 1=consumeStake, 2=consumeNayClaimable, 3=markNayResolved, 4=setNayClaimable
    function rewardsAction(uint8 action, uint256 campaignId, address target, uint256 value)
        external returns (uint256);

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getVoteRecord(uint256 campaignId, address voter) external view returns (VoteRecord memory);
    function getCampaignVote(uint256 campaignId) external view returns (CampaignVote memory);
    function nayClaimable(uint256 campaignId, address voter) external view returns (uint256);
    function getAyeVoters(uint256 campaignId) external view returns (address[] memory);
    function getNayVoters(uint256 campaignId) external view returns (address[] memory);
    function slashPool(uint256 campaignId) external view returns (uint256);
    function activationThreshold() external view returns (uint256);
    function terminationThreshold() external view returns (uint256);
    function minReviewerStake() external view returns (uint256);
    function baseLockupBlocks() external view returns (uint256);
    function maxLockupDuration() external view returns (uint256);
}
