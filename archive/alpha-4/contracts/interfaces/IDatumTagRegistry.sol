// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumTagRegistry
/// @notice Stake-gated, community-arbitrated tag namespace.
///
///         Anyone can register a `bytes32` tag by bonding WDATUM. The tag is
///         then usable by publishers running in `StakeGated` mode and by
///         advertisers running campaigns in `StakeGated` mode. Bonds are
///         slashable by anyone via a symmetric challenge: the challenger must
///         match the registrant's bond. Disputes are decided by a randomly-
///         selected, commit-reveal jury of WDATUM-staked jurors.
///
///         Unused tags decay: after `expiryBlocks` of inactivity any caller can
///         garbage-collect the tag and claim 100% of the bond as bounty.
interface IDatumTagRegistry {
    enum TagState { None, Bonded, Disputed, Expired }
    enum Vote { None, KeepTag, ExpireTag }

    // ---------------------------------------------------------------------
    // Tag lifecycle
    // ---------------------------------------------------------------------

    /// @notice Register a new tag, bonding `amount` WDATUM. Caller must have
    ///         approved the registry to pull `amount` first.
    function registerTag(bytes32 tag, uint256 amount) external;

    /// @notice Anyone may garbage-collect a tag that has been inactive for
    ///         at least `expiryBlocks`. Caller receives 100% of the bond.
    function expireTag(bytes32 tag) external;

    /// @notice Refresh `lastUsedBlock` for a tag. Only callable by the wired
    ///         Campaigns contract — invoked when a publisher sets the tag or
    ///         a campaign requires it.
    function recordUsage(bytes32 tag) external;

    /// @notice Open a challenge against an existing Bonded tag. Caller must
    ///         post a bond equal to the tag's own bond (symmetric).
    function challengeTag(bytes32 tag) external returns (uint256 disputeId);

    // ---------------------------------------------------------------------
    // Juror pool (Schelling-point arbitration)
    // ---------------------------------------------------------------------

    function stakeAsJuror(uint256 amount) external;
    function unstakeJuror(uint256 amount) external;

    function commitVote(uint256 disputeId, bytes32 commitHash) external;
    function revealVote(uint256 disputeId, Vote vote, bytes32 salt) external;
    function resolveDispute(uint256 disputeId) external;

    // ---------------------------------------------------------------------
    // Views — Campaigns reads these on the hot path.
    // ---------------------------------------------------------------------

    /// @notice True iff the tag is currently in the Bonded state. A disputed
    ///         tag returns false (publishers cannot newly adopt it until the
    ///         dispute resolves).
    function isTagBonded(bytes32 tag) external view returns (bool);

    function tagState(bytes32 tag) external view returns (TagState);
    function tagOwner(bytes32 tag) external view returns (address);
    function tagBond(bytes32 tag) external view returns (uint256);
    function tagLastUsedBlock(bytes32 tag) external view returns (uint64);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event TagRegistered(bytes32 indexed tag, address indexed owner, uint256 bond);
    event TagUsageRecorded(bytes32 indexed tag, uint64 block_);
    event TagExpired(bytes32 indexed tag, address indexed reclaimer, uint256 bounty);

    event JurorStaked(address indexed juror, uint256 amount, uint256 total);
    event JurorUnstaked(address indexed juror, uint256 amount, uint256 remaining);

    event DisputeOpened(
        uint256 indexed disputeId,
        bytes32 indexed tag,
        address indexed challenger,
        uint256 bond,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event VoteCommitted(uint256 indexed disputeId, address indexed juror);
    event VoteRevealed(uint256 indexed disputeId, address indexed juror, Vote vote);
    event DisputeResolved(
        uint256 indexed disputeId,
        bytes32 indexed tag,
        Vote outcome,
        uint16 keepVotes,
        uint16 expireVotes
    );

    event MinTagBondSet(uint256 amount);
    event JurorMinStakeSet(uint256 amount);
    event CommitWindowSet(uint64 blocks_);
    event RevealWindowSet(uint64 blocks_);
    event JurySizeSet(uint8 size);
    event JuryRewardBpsSet(uint16 bps);
    event JurorSlashBpsSet(uint16 bps);
    event ExpiryBlocksSet(uint64 blocks_);
    event CampaignsContractSet(address indexed campaigns);
    event CampaignsContractLocked();
}
