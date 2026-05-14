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

    // Governable quadratic conviction curve (defaults A=25, B=50 → weight(8)=21x).
    uint256 public constant CONVICTION_SCALE = 100;
    uint256 public constant MAX_LOCKUP_BLOCKS = 10_512_000;

    uint256 public convictionA;
    uint256 public convictionB;
    uint256[9] public convictionLockup;

    event ConvictionCurveSet(uint256 a, uint256 b);
    event ConvictionLockupsSet(uint256[9] lockups);

    /// @notice M-2 audit fix: per-proposal snapshot of conviction curve.
    mapping(uint256 => uint256) public proposalConvictionA;
    mapping(uint256 => uint256) public proposalConvictionB;

    function _weight(uint256 proposalId, uint8 c) internal view returns (uint256) {
        uint256 cu = uint256(c);
        uint256 a = proposalConvictionA[proposalId];
        uint256 b = proposalConvictionB[proposalId];
        if (a == 0 && b == 0) {
            a = convictionA;
            b = convictionB;
        }
        return (a * cu * cu + b * cu) / CONVICTION_SCALE + 1;
    }

    function _lockup(uint8 c) internal view returns (uint256) {
        return convictionLockup[c];
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

        // Default quadratic conviction curve.
        convictionA = 25;
        convictionB = 50;
        convictionLockup[0] = 0;
        convictionLockup[1] = 14400;
        convictionLockup[2] = 43200;
        convictionLockup[3] = 100800;
        convictionLockup[4] = 302400;
        convictionLockup[5] = 1296000;
        convictionLockup[6] = 2592000;
        convictionLockup[7] = 3888000;
        convictionLockup[8] = 5256000;
    }

    // ── Admin (lock-once on stake ref) ─────────────────────────────────────────

    /// @dev Lock-once: AdvertiserStake.slash() must come from this contract;
    ///      a hot-swap allows unilateral slashing of any advertiser.
    function setAdvertiserStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(advertiserStake) == address(0), "already set");
        advertiserStake = IDatumAdvertiserStake(addr);
    }

    event ParamsSet(uint256 quorum, uint256 slashBps, uint256 grace, uint256 bond);

    function setParams(uint256 _quorum, uint256 _slashBps, uint256 _grace, uint256 _bond) external onlyOwner {
        require(_slashBps <= 10_000, "E11");
        quorum = _quorum;
        slashBps = _slashBps;
        minGraceBlocks = _grace;
        proposeBond = _bond;
        emit ParamsSet(_quorum, _slashBps, _grace, _bond);
    }

    function setConvictionCurve(uint256 a, uint256 b) external onlyOwner {
        uint256 maxWeight = (a * 64 + b * 8) / CONVICTION_SCALE + 1;
        require(maxWeight <= 1000, "E11");
        convictionA = a; convictionB = b;
        emit ConvictionCurveSet(a, b);
    }

    function setConvictionLockups(uint256[9] calldata l) external onlyOwner {
        for (uint256 i = 0; i < 9; i++) {
            require(l[i] <= MAX_LOCKUP_BLOCKS, "E11");
            convictionLockup[i] = l[i];
        }
        emit ConvictionLockupsSet(l);
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
        // M-2: snapshot the conviction curve at propose time.
        proposalConvictionA[id] = convictionA;
        proposalConvictionB[id] = convictionB;
        emit AdvertiserFraudProposed(id, advertiser, msg.sender, evidenceHash);
    }

    function vote(uint256 id, bool aye, uint8 conviction) external payable whenNotPaused {
        require(conviction <= MAX_CONVICTION, "E40");
        Proposal storage p = proposals[id];
        require(p.startBlock != 0 && !p.resolved, "E50");
        require(msg.value > 0, "E11");
        require(votes[id][msg.sender].stake == 0, "E42"); // single vote per user per proposal

        uint256 w = msg.value * _weight(id, conviction);
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
        // L-3 audit fix: revert on any other sender so mistransfers can't
        // silently orphan DOT in this contract (sweepTreasury only sweeps
        // tracked treasuryBalance, not the contract's actual balance).
        require(msg.sender == address(advertiserStake), "E03");
        treasuryBalance += msg.value;
    }
}
