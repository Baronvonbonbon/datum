// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumRelayGovernance
/// @notice Conviction-vote fraud proposals against relays. Mirrors
///         DatumPublisherGovernance / DatumAdvertiserGovernance in shape;
///         differences:
///           - Targets a relay (instead of a publisher / advertiser).
///           - Reason codes encode the alleged offense category:
///               1 = censorship (relay dropped accepted batches)
///               2 = front-running / reordering
///               3 = MEV / timing extraction
///               4 = collusion (with publisher / advertiser)
///           - Slash flows through DatumRelayStake.slash.
interface IDatumRelayGovernance {
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed relay,
        address indexed proposer,
        uint8 reasonCode,
        bytes32 evidenceHash
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool aye,
        uint256 lockAmount,
        uint8 conviction
    );
    event VoteWithdrawn(uint256 indexed proposalId, address indexed voter, uint256 amount);
    event VoteRefunded(uint256 indexed proposalId, address indexed voter, uint256 amount);
    event ProposalResolved(
        uint256 indexed proposalId,
        address indexed relay,
        bool fraudUpheld,
        uint256 slashAmount
    );
    event ProposeBondQueued(address indexed recipient, uint256 amount, bool quorumReached);

    event ConvictionCurveSet(uint256 a, uint256 b);
    event ConvictionLockupsSet(uint256[9] lockups);
    event QuorumSet(uint256 value);
    event SlashAmountBpsSet(uint16 value);
    event TreasuryBpsSet(uint16 value);
    event MinGraceBlocksSet(uint256 value);
    event ProposeBondSet(uint256 value);
    event RelayStakeSet(address indexed relayStake);
    event PauseRegistrySet(address indexed pauseRegistry);
    event PlumbingLocked();

    struct Proposal {
        address relay;
        address proposer;
        uint8   reasonCode;
        bytes32 evidenceHash;
        uint256 createdBlock;
        uint256 ayeWeighted;
        uint256 nayWeighted;
        uint256 firstNayBlock;
        uint256 bond;
        bool    resolved;
    }

    struct Vote {
        uint8   direction;        // 0 = none, 1 = aye, 2 = nay
        uint8   conviction;
        uint256 lockAmount;
        uint256 lockedUntilBlock;
    }

    function propose(address relay, uint8 reasonCode, bytes32 evidenceHash)
        external payable returns (uint256 proposalId);

    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable;
    function withdrawVote(uint256 proposalId) external;
    function resolve(uint256 proposalId) external;
    function claimGovPayout() external;
    function claimGovPayoutTo(address recipient) external;
}
