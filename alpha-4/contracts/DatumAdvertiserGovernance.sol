// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumAdvertiserGovernance.sol";
import "./interfaces/IDatumAdvertiserStake.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";

/// @title DatumAdvertiserGovernance
/// @notice CB4: Conviction-weighted fraud proposals targeting advertisers.
///         Sibling of DatumPublisherGovernance for the advertiser-stake plane.
///
///         Participants lock DOT to vote aye (fraud) or nay (not fraud) on a
///         proposal. Conviction table identical to GovernanceV2 / PublisherGov:
///           0→1x/0d  1→2x/1d  2→3x/3d  3→4x/7d  4→6x/21d
///           5→9x/90d 6→14x/180d 7→18x/270d 8→21x/365d
///
///         Resolution:
///           - ayeWeighted > nayWeighted AND ayeWeighted >= quorum → FRAUD UPHELD
///           - else → NOT FRAUD
///           - minGraceBlocks must elapse after any nay vote before resolution
///
///         On fraud upheld: slashBps of the advertiser's stake is slashed via
///         DatumAdvertiserStake.slash(). Proceeds accumulate in this contract
///         as treasury (pull-payment via sweepTreasury).
///
///         Losing voters' DOT is NOT slashed (mirrors PublisherGov) — they
///         simply cannot withdraw until lockup expires.
contract DatumAdvertiserGovernance is IDatumAdvertiserGovernance, PaseoSafeSender, DatumOwnable {
    uint8 public constant MAX_CONVICTION = 8;

    function _weight(uint8 c) internal pure returns (uint256) {
        uint256[9] memory w = [uint256(1), 2, 3, 4, 6, 9, 14, 18, 21];
        return w[c];
    }

    function _lockup(uint8 c) internal pure returns (uint256) {
        uint256[9] memory l = [uint256(0), 14400, 43200, 100800, 302400, 1296000, 2592000, 3888000, 5256000];
        return l[c];
    }

    // ── Configuration ──────────────────────────────────────────────────────────

    IDatumAdvertiserStake public advertiserStake;
    IDatumPauseRegistry public pauseRegistry;

    uint256 public quorum;
    uint256 public slashBps;
    uint256 public minGraceBlocks;
    uint256 public proposeBond;

    /// @notice Pull-payment queue (G-M3 pattern).
    mapping(address => uint256) public pendingGovPayout;
    uint256 public treasuryBalance;

    event GovPayoutQueued(address indexed recipient, uint256 amount, string reason);
    event GovPayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event TreasurySwept(address indexed owner, uint256 amount);

    // ── Proposal storage ───────────────────────────────────────────────────────

    mapping(uint256 => Proposal) public proposals;
    uint256 public nextProposalId;

    struct VoteRecord {
        uint256 stake;
        uint8   conviction;
        bool    aye;
        uint256 lockupEndBlock;
        bool    withdrawn;
    }
    mapping(uint256 => mapping(address => VoteRecord)) public votes;

    constructor(
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _minGraceBlocks,
        uint256 _proposeBond,
        address _pauseRegistry
    ) {
        require(_pauseRegistry != address(0), "E00");
        require(_slashBps <= 10_000, "E11");
        quorum = _quorum;
        slashBps = _slashBps;
        minGraceBlocks = _minGraceBlocks;
        proposeBond = _proposeBond;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    // ── Admin (lock-once on stake ref) ─────────────────────────────────────────

    /// @dev Lock-once: AdvertiserStake.slash() must come from this contract;
    ///      a hot-swap allows unilateral slashing of any advertiser.
    function setAdvertiserStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(advertiserStake) == address(0), "already set");
        advertiserStake = IDatumAdvertiserStake(addr);
    }

    function setParams(uint256 _quorum, uint256 _slashBps, uint256 _grace, uint256 _bond) external onlyOwner {
        require(_slashBps <= 10_000, "E11");
        quorum = _quorum;
        slashBps = _slashBps;
        minGraceBlocks = _grace;
        proposeBond = _bond;
    }

    modifier whenNotPaused() { require(!pauseRegistry.pausedGovernance(), "P"); _; }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /// @notice Open a fraud proposal against `advertiser`. Caller locks `proposeBond`
    ///         DOT; refundable on resolution (any outcome that reaches quorum).
    function propose(address advertiser, bytes32 evidenceHash) external payable whenNotPaused returns (uint256 id) {
        require(advertiser != address(0), "E00");
        require(msg.value == proposeBond, "E11");
        id = ++nextProposalId;
        proposals[id] = Proposal({
            advertiser: advertiser,
            evidenceHash: evidenceHash,
            ayeWeighted: 0,
            nayWeighted: 0,
            startBlock: block.number,
            lastNayBlock: 0,
            resolved: false,
            upheld: false,
            proposer: msg.sender,
            bondLocked: msg.value
        });
        emit AdvertiserFraudProposed(id, advertiser, msg.sender, evidenceHash);
    }

    function vote(uint256 id, bool aye, uint8 conviction) external payable whenNotPaused {
        require(conviction <= MAX_CONVICTION, "E40");
        Proposal storage p = proposals[id];
        require(p.startBlock != 0 && !p.resolved, "E50");
        require(msg.value > 0, "E11");
        require(votes[id][msg.sender].stake == 0, "E42"); // single vote per user per proposal

        uint256 w = msg.value * _weight(conviction);
        uint256 lockup = block.number + _lockup(conviction);

        votes[id][msg.sender] = VoteRecord({
            stake: msg.value,
            conviction: conviction,
            aye: aye,
            lockupEndBlock: lockup,
            withdrawn: false
        });
        if (aye) {
            p.ayeWeighted += w;
        } else {
            p.nayWeighted += w;
            p.lastNayBlock = block.number;
        }
        emit AdvertiserFraudVoted(id, msg.sender, aye, conviction, w);
    }

    function resolve(uint256 id) external nonReentrant whenNotPaused {
        Proposal storage p = proposals[id];
        require(p.startBlock != 0 && !p.resolved, "E50");
        // Grace period after last nay vote so an aye majority can't snipe a
        // resolution before nay voters have time to coordinate further opposition.
        if (p.lastNayBlock != 0) {
            require(block.number >= p.lastNayBlock + minGraceBlocks, "E51");
        }

        bool upheld = (p.ayeWeighted > p.nayWeighted) && (p.ayeWeighted >= quorum);
        p.resolved = true;
        p.upheld = upheld;

        // Refund the propose bond on any quorum-reaching outcome; forfeit otherwise.
        bool quorumReached = (p.ayeWeighted + p.nayWeighted) >= quorum;
        if (p.bondLocked > 0) {
            if (quorumReached) {
                pendingGovPayout[p.proposer] += p.bondLocked;
                emit GovPayoutQueued(p.proposer, p.bondLocked, "propose-bond-refund");
            } else {
                treasuryBalance += p.bondLocked;
            }
            p.bondLocked = 0;
        }

        uint256 slashed = 0;
        if (upheld && address(advertiserStake) != address(0) && slashBps > 0) {
            // Slash a percentage of the advertiser's current stake.
            uint256 currentStake = advertiserStake.staked(p.advertiser);
            slashed = currentStake * slashBps / 10_000;
            if (slashed > 0) {
                advertiserStake.slash(p.advertiser, slashed, address(this));
                emit AdvertiserSlashed(p.advertiser, slashed);
            }
        }
        emit AdvertiserFraudResolved(id, upheld, slashed);
    }

    // ── Voter stake withdrawal ─────────────────────────────────────────────────

    function withdrawVote(uint256 id) external nonReentrant {
        Proposal storage p = proposals[id];
        VoteRecord storage v = votes[id][msg.sender];
        require(v.stake > 0 && !v.withdrawn, "E03");
        require(p.resolved, "E51");
        require(block.number >= v.lockupEndBlock, "E70");
        uint256 amount = v.stake;
        v.withdrawn = true;
        _safeSend(msg.sender, amount);
    }

    // ── Payout queue ───────────────────────────────────────────────────────────

    function claimGovPayout() external nonReentrant {
        uint256 amount = pendingGovPayout[msg.sender];
        require(amount > 0, "E03");
        pendingGovPayout[msg.sender] = 0;
        emit GovPayoutClaimed(msg.sender, msg.sender, amount);
        _safeSend(msg.sender, amount);
    }

    function sweepTreasury() external onlyOwner {
        uint256 amount = treasuryBalance;
        require(amount > 0, "E03");
        treasuryBalance = 0;
        pendingGovPayout[owner()] += amount;
        emit TreasurySwept(owner(), amount);
    }

    // ── Accept slash proceeds ──────────────────────────────────────────────────
    receive() external payable {
        // Slashed DOT lands here from AdvertiserStake — credit to treasury.
        if (msg.sender == address(advertiserStake)) {
            treasuryBalance += msg.value;
        }
    }
}
