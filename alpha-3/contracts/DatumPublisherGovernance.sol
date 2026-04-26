// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumPublisherGovernance.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumChallengeBonds.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumPublisherGovernance
/// @notice FP-3: Conviction-weighted fraud proposals targeting publishers.
///
///         Participants lock DOT to vote aye (fraud) or nay (not fraud) on a proposal.
///         Conviction table is identical to GovernanceV2 (hardcoded for PVM efficiency):
///           0→1x/0d  1→2x/1d  2→3x/3d  3→4x/7d  4→6x/21d
///           5→9x/90d 6→14x/180d 7→18x/270d 8→21x/365d
///
///         Resolution conditions:
///           - ayeWeighted > nayWeighted  AND  ayeWeighted >= quorum  → FRAUD UPHELD
///           - nayWeighted >= ayeWeighted OR ayeWeighted < quorum      → NOT FRAUD
///           - A grace period (minGraceBlocks) must elapse after any nay vote
///             before resolution is allowed.
///
///         On fraud upheld:
///           - slashBps of publisher's stake is slashed via DatumPublisherStake.
///           - bondBonusBps of the slashed amount is forwarded to ChallengeBonds.addToPool().
///           - Remainder stays in this contract (protocol treasury).
///
///         Losing voters' DOT is NOT slashed (unlike GovernanceV2 campaign slash) —
///         they simply can't withdraw until lockup expires.
contract DatumPublisherGovernance is IDatumPublisherGovernance, ReentrancyGuard, Ownable2Step {
    uint8 public constant MAX_CONVICTION = 8;

    // ── Conviction table (same as GovernanceV2, hardcoded for PVM size) ────────

    function _weight(uint8 c) internal pure returns (uint256) {
        if (c == 0) return 1;
        if (c == 1) return 2;
        if (c == 2) return 3;
        if (c == 3) return 4;
        if (c == 4) return 6;
        if (c == 5) return 9;
        if (c == 6) return 14;
        if (c == 7) return 18;
        return 21; // c == 8
    }

    function _lockup(uint8 c) internal pure returns (uint256) {
        if (c == 0) return 0;
        if (c == 1) return 14400;
        if (c == 2) return 43200;
        if (c == 3) return 100800;
        if (c == 4) return 302400;
        if (c == 5) return 1296000;
        if (c == 6) return 2592000;
        if (c == 7) return 3888000;
        return 5256000; // c == 8
    }

    // ── Configuration ──────────────────────────────────────────────────────────

    IDatumPublisherStake public publisherStake;
    IDatumChallengeBonds public challengeBonds;
    IDatumPauseRegistry public pauseRegistry;

    uint256 public quorum;
    uint256 public slashBps;
    uint256 public bondBonusBps;
    uint256 public minGraceBlocks;

    modifier whenNotPaused() {
        require(!pauseRegistry.paused(), "P");
        _;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 public nextProposalId;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Vote)) private _votes;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _publisherStake,
        address _challengeBonds,
        address _pauseRegistry,
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _bondBonusBps,
        uint256 _minGraceBlocks
    ) Ownable(msg.sender) {
        require(_publisherStake != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        require(_slashBps <= 10000, "E00");
        require(_bondBonusBps <= 10000, "E00");
        publisherStake = IDatumPublisherStake(_publisherStake);
        challengeBonds = _challengeBonds == address(0) ? IDatumChallengeBonds(address(0)) : IDatumChallengeBonds(_challengeBonds);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        quorum = _quorum;
        slashBps = _slashBps;
        bondBonusBps = _bondBonusBps;
        minGraceBlocks = _minGraceBlocks;
        nextProposalId = 1;
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setPublisherStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        publisherStake = IDatumPublisherStake(addr);
    }

    function setChallengeBonds(address addr) external onlyOwner {
        challengeBonds = IDatumChallengeBonds(addr);
    }

    function setPauseRegistry(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        pauseRegistry = IDatumPauseRegistry(addr);
    }

    function setParams(uint256 _quorum, uint256 _slashBps, uint256 _bondBonusBps, uint256 _minGrace) external onlyOwner {
        require(_slashBps <= 10000, "E00");
        require(_bondBonusBps <= 10000, "E00");
        quorum = _quorum;
        slashBps = _slashBps;
        bondBonusBps = _bondBonusBps;
        minGraceBlocks = _minGrace;
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

    // ── Publisher governance actions ───────────────────────────────────────────

    /// @inheritdoc IDatumPublisherGovernance
    function propose(address publisher, bytes32 evidenceHash) external whenNotPaused {
        require(publisher != address(0), "E00");
        require(evidenceHash != bytes32(0), "E00");

        uint256 proposalId = nextProposalId++;
        _proposals[proposalId] = Proposal({
            publisher: publisher,
            evidenceHash: evidenceHash,
            createdBlock: block.number,
            resolved: false,
            ayeWeighted: 0,
            nayWeighted: 0,
            firstNayBlock: 0
        });

        emit ProposalCreated(proposalId, publisher, evidenceHash);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "E11");
        require(conviction <= MAX_CONVICTION, "E40");

        Proposal storage p = _proposals[proposalId];
        require(p.createdBlock > 0, "E01");
        require(!p.resolved, "E41");

        Vote storage v = _votes[proposalId][msg.sender];

        // Remove existing vote weight (re-vote support)
        if (v.direction != 0) {
            uint256 existingWeight = v.lockAmount * _weight(v.conviction);
            if (v.direction == 1) {
                p.ayeWeighted -= existingWeight;
            } else {
                p.nayWeighted -= existingWeight;
                // Note: firstNayBlock remains set (most conservative)
            }
            // Refund prior lock if unlocked; otherwise fail gracefully
            // (voter must wait for their lockup to expire before re-voting)
            require(block.number >= v.lockedUntilBlock, "E42"); // prior lock still active
            // Refund old locked amount — AUDIT-007: emit event for auditability
            uint256 refundAmount = v.lockAmount;
            (bool ok,) = msg.sender.call{value: refundAmount}("");
            require(ok, "E02");
            emit VoteRefunded(proposalId, msg.sender, refundAmount);
        }

        uint256 weight = msg.value * _weight(conviction);
        uint256 lockup = _lockup(conviction);

        v.direction = aye ? 1 : 2;
        v.lockAmount = msg.value;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;

        if (aye) {
            p.ayeWeighted += weight;
        } else {
            p.nayWeighted += weight;
            if (p.firstNayBlock == 0) p.firstNayBlock = block.number;
        }

        emit VoteCast(proposalId, msg.sender, aye, msg.value, conviction);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function withdrawVote(uint256 proposalId) external nonReentrant {
        Vote storage v = _votes[proposalId][msg.sender];
        require(v.direction != 0, "E01");
        require(block.number >= v.lockedUntilBlock, "E42");

        Proposal storage p = _proposals[proposalId];
        uint256 weight = v.lockAmount * _weight(v.conviction);
        if (v.direction == 1) {
            if (p.ayeWeighted >= weight) p.ayeWeighted -= weight;
        } else {
            if (p.nayWeighted >= weight) p.nayWeighted -= weight;
        }

        uint256 amount = v.lockAmount;
        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "E02");
        emit VoteWithdrawn(proposalId, msg.sender, amount);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function resolve(uint256 proposalId) external nonReentrant whenNotPaused {
        Proposal storage p = _proposals[proposalId];
        require(p.createdBlock > 0, "E01");
        require(!p.resolved, "E41");

        // Grace period: must wait minGraceBlocks after first nay vote (if any)
        if (p.firstNayBlock > 0) {
            require(block.number >= p.firstNayBlock + minGraceBlocks, "E43");
        }

        p.resolved = true;

        bool fraudUpfield = p.ayeWeighted > p.nayWeighted && p.ayeWeighted >= quorum;
        uint256 slashAmount = 0;

        if (fraudUpfield) {
            // Slash publisher stake
            uint256 publisherStakeAmt = publisherStake.staked(p.publisher);
            slashAmount = (publisherStakeAmt * slashBps) / 10000;

            if (slashAmount > 0) {
                // Slash to this contract first, then distribute
                publisherStake.slash(p.publisher, slashAmount, address(this));

                // Forward bondBonusBps share to challenge bonds pool
                if (address(challengeBonds) != address(0) && bondBonusBps > 0) {
                    uint256 bonusShare = (slashAmount * bondBonusBps) / 10000;
                    if (bonusShare > 0 && bonusShare <= address(this).balance) {
                        challengeBonds.addToPool{value: bonusShare}(p.publisher);
                    }
                }
                // Remainder stays in this contract (protocol treasury)
            }
        }

        emit ProposalResolved(proposalId, p.publisher, fraudUpfield, slashAmount);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVote(uint256 proposalId, address voter) external view returns (Vote memory) {
        return _votes[proposalId][voter];
    }

    /// @notice Returns the weight multiplier for a conviction level.
    function convictionWeight(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _weight(conviction);
    }

    /// @notice Returns the lockup duration in blocks for a conviction level.
    function convictionLockup(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _lockup(conviction);
    }

    /// @notice Allow receiving slashed funds from PublisherStake.slash().
    receive() external payable {}
}
