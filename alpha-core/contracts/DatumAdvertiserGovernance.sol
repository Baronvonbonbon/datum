// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumAdvertiserGovernance.sol";
import "./interfaces/IDatumAdvertiserStake.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./DatumPlumbingLockable.sol";
import "./PaseoSafeSender.sol";
import "./lib/ParameterRetuneGuard.sol";

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
contract DatumAdvertiserGovernance is
    IDatumAdvertiserGovernance,
    PaseoSafeSender,
    DatumPlumbingLockable,
    ParameterRetuneGuard
{
    /// @notice F-031 fix (2026-05-20): per-key retune cooldown.
    function setRetuneCooldownBlocks(uint256 blocks_) external onlyOwner {
        _setRetuneCooldownBlocks(blocks_);
    }
    /// v2: parameter-governance Phase B — routes parameter setters
    /// (setParams, setConvictionCurve, setConvictionLockups,
    /// setPublisherClaimBond) through `onlyOwnerOrPG`. Wiring setters
    /// (setAdvertiserStake, setCouncilArbiter) remain owner-only.
    function version() public pure virtual override returns (uint256) { return 2; }

    /// @notice ParameterGovernance address authorised to retune Phase B
    ///         parameters via its bicameral veto-window flow. Lock-once.
    address public parameterGovernance;
    event ParameterGovernanceSet(address indexed pg);

    /// @dev Owner OR ParameterGovernance.
    modifier onlyOwnerOrPG() {
        require(msg.sender == owner() || msg.sender == parameterGovernance, "E18");
        _;
    }

    function setParameterGovernance(address pg) external onlyOwner whenPlumbingUnlocked {
        require(pg != address(0), "E00");
        parameterGovernance = pg;
        emit ParameterGovernanceSet(pg);
    }

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

    // ── Enumeration for upgrade migration (holds locked conviction DOT) ──
    address[] private _govPayoutHolders;
    mapping(address => bool) private _govPayoutTracked;
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    function _queueGovPayout(address a, uint256 amt) internal {
        pendingGovPayout[a] += amt;
        if (a != address(0) && !_govPayoutTracked[a]) { _govPayoutTracked[a] = true; _govPayoutHolders.push(a); }
    }

    event GovPayoutQueued(address indexed recipient, uint256 amount, string reason);
    event GovPayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event TreasurySwept(address indexed owner, uint256 amount);

    // -------------------------------------------------------------------------
    // G-3 first close (2026-05-20): Council-arbitrated publisher → advertiser
    // fraud claims. Mirror of DatumPublisherGovernance.fileAdvertiserFraudClaim.
    // Closes the asymmetry where advertisers had a fast Council-arbitrated
    // track against publishers but publishers had no equivalent against
    // advertisers. Same shape: filer stakes a bond + evidence CID, Council
    // resolves off-chain review on-chain via councilResolvePublisherClaim.
    //
    //   upheld    → advertiser stake slashed; bond refunded to filer.
    //   dismissed → bond forwarded to advertiser as compensation.
    //
    // Lock-once on councilArbiter, configurable bond, anti-self check.
    // -------------------------------------------------------------------------

    struct PublisherFraudClaim {
        address publisher;        // who filed (typically a publisher; not enforced on-chain)
        address advertiser;       // target
        uint256 campaignId;       // 0 = advertiser-wide claim
        bytes32 evidenceHash;     // IPFS CID of analytics evidence
        uint256 bond;             // filer-staked bond
        bool resolved;
        bool upheld;
        uint256 createdBlock;
    }

    /// @notice Council contract authorized to resolve publisher fraud claims.
    address public councilArbiter;
    /// @notice Bond required to file a publisher fraud claim. 0 disables the track.
    uint256 public publisherClaimBond;
    /// @notice Auto-incrementing claim id.
    uint256 public nextPublisherClaimId = 1;
    mapping(uint256 => PublisherFraudClaim) public publisherClaims;

    event CouncilArbiterSet(address indexed arbiter);
    event PublisherClaimBondSet(uint256 amount);
    event PublisherFraudClaimFiled(
        uint256 indexed claimId,
        address indexed publisher,
        address indexed advertiser,
        uint256 campaignId,
        bytes32 evidenceHash,
        uint256 bond
    );
    event PublisherFraudClaimResolved(
        uint256 indexed claimId,
        address indexed advertiser,
        bool upheld,
        uint256 slashAmount,
        uint256 bondDisposition
    );

    modifier onlyCouncilArbiter() {
        require(councilArbiter != address(0) && msg.sender == councilArbiter, "E18");
        _;
    }

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
    /// @dev Per-proposal voter enumeration for in-flight conviction-vote migration.
    mapping(uint256 => address[]) private _proposalVoters;
    mapping(uint256 => mapping(address => bool)) private _voterTracked;

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
    function setAdvertiserStake(address addr) external onlyOwner whenPlumbingUnlocked {
        require(addr != address(0), "E00");
        advertiserStake = IDatumAdvertiserStake(addr);
    }

    event ParamsSet(uint256 quorum, uint256 slashBps, uint256 grace, uint256 bond);

    function setParams(uint256 _quorum, uint256 _slashBps, uint256 _grace, uint256 _bond) external onlyOwnerOrPG {
        require(_slashBps <= 10_000, "E11");
        // F-031 fix: guard the slashBps key. setParams bundles multiple
        // tunables but slashBps is the load-bearing economic parameter;
        // a snap-retune would let a captured owner spike slashing in
        // back-to-back blocks. The cooldown applies to this key.
        _guardRetune("slashBps");
        quorum = _quorum;
        slashBps = _slashBps;
        minGraceBlocks = _grace;
        proposeBond = _bond;
        emit ParamsSet(_quorum, _slashBps, _grace, _bond);
    }

    function setConvictionCurve(uint256 a, uint256 b) external onlyOwnerOrPG {
        // Mirrors the AUDIT-PASS-5 L6 guard in DatumGovernanceV2: keep the
        // (0, 0) pair reserved as a "not yet set" sentinel even though this
        // contract does not currently use per-proposal snapshots.
        require(a != 0 || b != 0, "E11");
        uint256 maxWeight = (a * 64 + b * 8) / CONVICTION_SCALE + 1;
        require(maxWeight <= 1000, "E11");
        _guardRetune("convictionCurve");
        convictionA = a; convictionB = b;
        emit ConvictionCurveSet(a, b);
    }

    function setConvictionLockups(uint256[9] calldata l) external onlyOwnerOrPG {
        for (uint256 i = 0; i < 9; i++) {
            require(l[i] <= MAX_LOCKUP_BLOCKS, "E11");
            convictionLockup[i] = l[i];
        }
        emit ConvictionLockupsSet(l);
    }

    // ── G-3 admin: Council arbiter + claim bond ────────────────────────────────

    /// @notice Set the Council contract authorized to resolve publisher fraud
    ///         claims. Cypherpunk lock-once: a hot-swappable arbiter is a
    ///         unilateral slash backdoor. address(0) leaves the Council-
    ///         arbitrated track disabled; once set non-zero it's frozen.
    function setCouncilArbiter(address arbiter) external onlyOwner whenPlumbingUnlocked {
        require(arbiter != address(0), "E00");
        councilArbiter = arbiter;
        emit CouncilArbiterSet(arbiter);
    }

    /// @notice Set the bond required for filing a publisher fraud claim.
    ///         Bond refunded on upheld, forwarded to advertiser on dismissed.
    ///         Set to 0 to disable the Council-arbitrated track entirely.
    function setPublisherClaimBond(uint256 amount) external onlyOwnerOrPG {
        _guardRetune("publisherClaimBond");
        publisherClaimBond = amount;
        emit PublisherClaimBondSet(amount);
    }

    modifier whenNotPaused() { require(!pauseRegistry.pausedGovernance(), "P"); _; }

    // ── G-3: Council-arbitrated publisher → advertiser fraud claims ──────────

    /// @notice File a fraud claim against an advertiser. Stake `publisherClaimBond`
    ///         to file. Council resolves later via `councilResolvePublisherClaim`.
    /// @param advertiser    Advertiser being accused.
    /// @param campaignId    Campaign-specific claim, or 0 for advertiser-wide.
    /// @param evidenceHash  IPFS CID of analytics evidence reviewed off-chain.
    function filePublisherFraudClaim(address advertiser, uint256 campaignId, bytes32 evidenceHash)
        external
        payable
        whenNotPaused
        whenNotFrozen
        returns (uint256 claimId)
    {
        require(advertiser != address(0), "E00");
        require(evidenceHash != bytes32(0), "E00");
        require(publisherClaimBond > 0, "E01"); // track disabled
        require(msg.value == publisherClaimBond, "E11");
        require(councilArbiter != address(0), "E01");
        // Anti-laundering: cannot file against self.
        require(msg.sender != advertiser, "E18");

        claimId = nextPublisherClaimId++;
        publisherClaims[claimId] = PublisherFraudClaim({
            publisher: msg.sender,
            advertiser: advertiser,
            campaignId: campaignId,
            evidenceHash: evidenceHash,
            bond: msg.value,
            resolved: false,
            upheld: false,
            createdBlock: block.number
        });
        emit PublisherFraudClaimFiled(claimId, msg.sender, advertiser, campaignId, evidenceHash, msg.value);
    }

    /// @notice Council resolves a filed publisher fraud claim. Called by the
    ///         Council contract after its propose+vote+execute cycle.
    /// @param claimId  The publisher claim id.
    /// @param upheld   true = fraud confirmed; false = claim dismissed.
    function councilResolvePublisherClaim(uint256 claimId, bool upheld)
        external
        onlyCouncilArbiter
        nonReentrant
        whenNotFrozen
    {
        PublisherFraudClaim storage c = publisherClaims[claimId];
        require(c.createdBlock > 0, "E01");
        require(!c.resolved, "E41");
        c.resolved = true;
        c.upheld = upheld;

        uint256 slashAmount = 0;
        uint256 bond = c.bond;
        c.bond = 0;
        uint256 bondDisposition = bond;

        if (upheld) {
            // Slash advertiser stake — same distribution as conviction track.
            // Slashed DOT lands in this contract's treasuryBalance via receive().
            if (address(advertiserStake) != address(0) && slashBps > 0) {
                uint256 currentStake = advertiserStake.staked(c.advertiser);
                slashAmount = (currentStake * slashBps) / 10_000;
                if (slashAmount > 0) {
                    advertiserStake.slash(c.advertiser, slashAmount, address(this));
                    emit AdvertiserSlashed(c.advertiser, slashAmount);
                }
            }
            // Bond refunded to filer (queue pull).
            if (bond > 0) {
                _queueGovPayout(c.publisher, bond);
                emit GovPayoutQueued(c.publisher, bond, "publisher fraud claim upheld");
            }
        } else {
            // Dismissed: bond → advertiser (compensation for false claim).
            if (bond > 0) {
                _queueGovPayout(c.advertiser, bond);
                emit GovPayoutQueued(c.advertiser, bond, "publisher fraud claim dismissed");
            }
        }
        emit PublisherFraudClaimResolved(claimId, c.advertiser, upheld, slashAmount, bondDisposition);
    }

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

    function vote(uint256 id, bool aye, uint8 conviction) external payable whenNotPaused whenNotFrozen {
        require(conviction <= MAX_CONVICTION, "E40");
        Proposal storage p = proposals[id];
        require(p.startBlock != 0 && !p.resolved, "E50");
        require(msg.value > 0, "E11");
        require(votes[id][msg.sender].stake == 0, "E42"); // single vote per user per proposal
        if (!_voterTracked[id][msg.sender]) { _voterTracked[id][msg.sender] = true; _proposalVoters[id].push(msg.sender); }

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

    function resolve(uint256 id) external nonReentrant whenNotPaused whenNotFrozen {
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
                _queueGovPayout(p.proposer, p.bondLocked);
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

    function withdrawVote(uint256 id) external nonReentrant whenNotFrozen {
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

    function claimGovPayout() external nonReentrant whenNotFrozen {
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
        _queueGovPayout(owner(), amount);
        emit TreasurySwept(owner(), amount);
    }

    // ── Accept slash proceeds ──────────────────────────────────────────────────
    receive() external payable whenNotFrozen {
        // Slashed DOT lands here from AdvertiserStake — credit to treasury.
        // L-3 audit fix: revert on any other sender so mistransfers can't
        // silently orphan DOT in this contract (sweepTreasury only sweeps
        // tracked treasuryBalance, not the contract's actual balance).
        require(msg.sender == address(advertiserStake), "E03");
        treasuryBalance += msg.value;
    }

    // ── Upgrade migration (config + settled payout queue; native sweep) ──

    function govPayoutHolderCount() external view returns (uint256) { return _govPayoutHolders.length; }
    function govPayoutHolderAt(uint256 i) external view returns (address) { return _govPayoutHolders[i]; }
    function getProposal(uint256 id) external view returns (Proposal memory) { return proposals[id]; }
    function getVoteRecord(uint256 id, address voter) external view returns (VoteRecord memory) { return votes[id][voter]; }
    function proposalVoterCount(uint256 id) external view returns (uint256) { return _proposalVoters[id].length; }
    function proposalVoterAt(uint256 id, uint256 i) external view returns (address) { return _proposalVoters[id][i]; }

    /// @dev Copy governance params + treasury accounting + Council-claim config +
    ///      settled pending payouts from a frozen predecessor. In-flight
    ///      proposals/votes/claims are drained pre-migration. Refs
    ///      (advertiserStake / pauseRegistry / parameterGovernance) are re-wired.
    function _migrate(address oldContract) internal override {
        DatumAdvertiserGovernance old = DatumAdvertiserGovernance(payable(oldContract));
        quorum = old.quorum();
        slashBps = old.slashBps();
        minGraceBlocks = old.minGraceBlocks();
        proposeBond = old.proposeBond();
        convictionA = old.convictionA();
        convictionB = old.convictionB();
        for (uint256 i = 0; i < 9; i++) convictionLockup[i] = old.convictionLockup(i);
        treasuryBalance = old.treasuryBalance();
        councilArbiter = old.councilArbiter();
        publisherClaimBond = old.publisherClaimBond();
        nextPublisherClaimId = old.nextPublisherClaimId();
        // In-flight proposals + their time-locked conviction votes (ids 1..nextProposalId).
        nextProposalId = old.nextProposalId();
        for (uint256 id = 1; id <= nextProposalId; id++) {
            proposals[id] = old.getProposal(id);
            proposalConvictionA[id] = old.proposalConvictionA(id);
            proposalConvictionB[id] = old.proposalConvictionB(id);
            uint256 vn = old.proposalVoterCount(id);
            for (uint256 j = 0; j < vn; j++) {
                address voter = old.proposalVoterAt(id, j);
                votes[id][voter] = old.getVoteRecord(id, voter);
                if (!_voterTracked[id][voter]) { _voterTracked[id][voter] = true; _proposalVoters[id].push(voter); }
            }
        }
        uint256 pn = old.govPayoutHolderCount();
        for (uint256 i = 0; i < pn; i++) {
            address a = old.govPayoutHolderAt(i);
            pendingGovPayout[a] = old.pendingGovPayout(a);
            if (!_govPayoutTracked[a]) { _govPayoutTracked[a] = true; _govPayoutHolders.push(a); }
        }
    }

    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumAdvertiserGovernance(payable(successor)).acceptMigration{value: bal}();
    }

    function acceptMigration() external payable {
        require(msg.sender == migrationSource, "not-source");
    }
}
