// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./lib/ParameterRetuneGuard.sol";
import "./interfaces/IDatumRelayStake.sol";
import "./interfaces/IDatumRelayGovernance.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title  DatumRelayGovernance
/// @notice G-1 first close: conviction-vote fraud proposals against relays.
///         Symmetric to DatumPublisherGovernance / DatumAdvertiserGovernance.
///         Voters lock DOT aye/nay on a proposal accusing a relay of one of:
///           reason 1: censorship (dropped accepted batches)
///           reason 2: front-running / reordering
///           reason 3: MEV / timing extraction
///           reason 4: collusion (with publisher / advertiser)
///
///         Resolution:
///           - ayeWeighted > nayWeighted AND ayeWeighted >= quorum  → FRAUD UPHELD
///             → slash slashAmountBps of the relay's stake via RelayStake.slash
///             → challengerBonusBps cut → proposer's pending payout queue
///             → treasuryBps cut       → treasury's pending payout queue
///             → remainder              → contract treasuryBalance (owner sweep)
///           - otherwise                                            → NOT FRAUD
///
///         Losing voters' DOT is NOT slashed (mirrors PublisherGovernance) —
///         they just can't withdraw until lockup expires.
///
///         M-2 audit fix: per-proposal snapshot of conviction curve. Mid-flight
///         retunes don't retroactively reweight votes.
///         L-6 audit fix: setConvictionCurve(0, 0) rejected.
///
///         Cypherpunk lock-once:
///           - relayStake / pauseRegistry refs lock-once on first non-zero set.
///           - lockPlumbing() freezes both pointers permanently
///             (phase-gated on OpenGov via DatumUpgradable.whenOpenGovPhase).
contract DatumRelayGovernance is
    IDatumRelayGovernance,
    PaseoSafeSender,
    DatumUpgradable,
    ParameterRetuneGuard
{
    function version() public pure virtual override returns (uint256) { return 1; }

    uint8 public constant MAX_CONVICTION = 8;
    uint256 public constant CONVICTION_SCALE = 100;
    uint256 public constant MAX_LOCKUP_BLOCKS = 10_512_000; // ~2y

    // ── Conviction curve ────────────────────────────────────────────────
    uint256 public convictionA;
    uint256 public convictionB;
    uint256[9] public convictionLockup;

    /// @notice M-2 audit: per-proposal snapshot of conviction curve.
    mapping(uint256 => uint256) public proposalConvictionA;
    mapping(uint256 => uint256) public proposalConvictionB;

    // ── Wiring ──────────────────────────────────────────────────────────
    IDatumRelayStake public relayStake;
    IDatumPauseRegistry public pauseRegistry;
    address public treasury;
    bool public plumbingLocked;

    // ── Governable parameters ──────────────────────────────────────────
    uint256 public quorum;
    uint256 public minGraceBlocks;
    uint256 public proposeBond;
    uint16  public slashAmountBps;       // % of relay's stake slashed on uphold
    uint16  public challengerBonusBps;   // % of slash to proposer
    uint16  public treasuryBps;          // % of slash to treasury

    /// @notice Pull-pattern payout queue for proposer / treasury / vote refunds.
    mapping(address => uint256) public pendingGovPayout;

    // ── Enumeration for upgrade migration (holds locked conviction DOT) ──
    // In-flight proposals/votes are drained pre-migration (resolved → refunds
    // queue into pendingGovPayout); _migrate copies config + the settled payout
    // queue, and migrateFundsTo sweeps the native DOT. All payout credits route
    // through _queueGovPayout so the holder set stays enumerable.
    address[] private _govPayoutHolders;
    mapping(address => bool) private _govPayoutTracked;
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    function _queueGovPayout(address a, uint256 amt) internal {
        pendingGovPayout[a] += amt;
        if (a != address(0) && !_govPayoutTracked[a]) { _govPayoutTracked[a] = true; _govPayoutHolders.push(a); }
    }
    /// @notice Owner-claimable residue (slash remainder after challenger+treasury cuts).
    uint256 public treasuryBalance;

    event TreasurySet(address indexed treasury);
    event TreasurySwept(address indexed owner, uint256 amount);
    event GovPayoutQueued(address indexed recipient, uint256 amount, string reason);
    event GovPayoutClaimed(address indexed recipient, address indexed to, uint256 amount);

    // ── State ───────────────────────────────────────────────────────────
    uint256 public nextProposalId;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    /// @dev Per-proposal voter enumeration so a successor's `_migrate` can copy
    ///      the in-flight (time-locked) conviction votes — they can't be drained
    ///      pre-migration, so the full vote state is carried over and the locked
    ///      DOT swept, fully retiring the predecessor.
    mapping(uint256 => address[]) private _proposalVoters;
    mapping(uint256 => mapping(address => bool)) private _voterTracked;

    // ── Errors ──────────────────────────────────────────────────────────
    error E00();    // address(0) / generic
    error E01();    // unknown proposal
    error E03();    // nothing to claim
    error E11();    // invalid parameter
    error E18();    // unauthorized
    error E40();    // bad conviction
    error E41();    // already resolved
    error E42();    // lockup not elapsed
    error E43();    // grace not elapsed
    error E68();    // bad reason
    error Paused();
    error AlreadySet();

    modifier whenNotPaused() {
        if (address(pauseRegistry) != address(0) && pauseRegistry.pausedGovernance()) revert Paused();
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────────
    constructor(
        uint256 _quorum,
        uint256 _minGraceBlocks,
        uint256 _proposeBond,
        uint16  _slashAmountBps,
        uint16  _challengerBonusBps,
        uint16  _treasuryBps
    ) DatumOwnable() {
        if (_slashAmountBps > 10000) revert E11();
        if (uint32(_challengerBonusBps) + uint32(_treasuryBps) > 10000) revert E11();
        quorum = _quorum;
        minGraceBlocks = _minGraceBlocks;
        proposeBond = _proposeBond;
        slashAmountBps = _slashAmountBps;
        challengerBonusBps = _challengerBonusBps;
        treasuryBps = _treasuryBps;
        nextProposalId = 1;

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

    /// @notice Accept slashed funds from DatumRelayStake.slash(). The receive
    ///         path tracks nothing — distribution happens in resolve() based
    ///         on the actual `slashed` return from RelayStake.
    receive() external payable whenNotFrozen {}

    // ── Wiring (lock-once) ──────────────────────────────────────────────
    function setRelayStake(address addr) external onlyOwner {
        if (plumbingLocked) revert AlreadySet();
        if (addr == address(0)) revert E00();
        if (address(relayStake) != address(0)) revert AlreadySet();
        relayStake = IDatumRelayStake(addr);
        emit RelayStakeSet(addr);
    }

    function setPauseRegistry(address addr) external onlyOwner {
        if (plumbingLocked) revert AlreadySet();
        if (addr == address(0)) revert E00();
        if (address(pauseRegistry) != address(0)) revert AlreadySet();
        pauseRegistry = IDatumPauseRegistry(addr);
        emit PauseRegistrySet(addr);
    }

    function setTreasury(address t) external onlyOwner whenNotFrozen {
        if (t == address(0) && treasuryBps != 0) revert E00();
        treasury = t;
        emit TreasurySet(t);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert AlreadySet();
        if (address(relayStake) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ── Parameter setters ───────────────────────────────────────────────
    //
    // G-10 first close (2026-05-20): high-impact economic setters guarded
    // by ParameterRetuneGuard cooldown. Defense-in-depth on top of the
    // upgrade-ladder Timelock — even if governance is compromised, slash
    // bps / conviction curve / treasury split cannot be snap-retuned
    // faster than retuneCooldownBlocks. Quorum / grace / propose-bond are
    // ungated because their damage profile is lower (rate-limiter, not
    // value-extraction).

    function setQuorum(uint256 v) external onlyOwner whenNotFrozen { quorum = v; emit QuorumSet(v); }
    function setMinGraceBlocks(uint256 v) external onlyOwner whenNotFrozen { minGraceBlocks = v; emit MinGraceBlocksSet(v); }
    function setProposeBond(uint256 v) external onlyOwner whenNotFrozen { proposeBond = v; emit ProposeBondSet(v); }

    function setSlashAmountBps(uint16 v) external onlyOwner whenNotFrozen {
        _guardRetune("slashAmountBps");
        if (v > 10000) revert E11();
        slashAmountBps = v;
        emit SlashAmountBpsSet(v);
    }

    function setChallengerBonusBps(uint16 v) external onlyOwner whenNotFrozen {
        _guardRetune("challengerBonusBps");
        if (uint32(v) + uint32(treasuryBps) > 10000) revert E11();
        challengerBonusBps = v;
        // Re-use TreasuryBpsSet for completeness — challenger emit
        // collapsed under a single PunishmentBpsSet would mirror RelayStake.
        emit TreasuryBpsSet(treasuryBps); // no-op echo for tooling
    }

    function setTreasuryBps(uint16 v) external onlyOwner whenNotFrozen {
        _guardRetune("treasuryBps");
        if (uint32(challengerBonusBps) + uint32(v) > 10000) revert E11();
        if (treasury == address(0) && v != 0) revert E00();
        treasuryBps = v;
        emit TreasuryBpsSet(v);
    }

    function setConvictionCurve(uint256 a, uint256 b) external onlyOwner whenNotFrozen {
        _guardRetune("convictionCurve");
        // L-6 fix: reject (0, 0). Reserved as the "not yet snapshotted" sentinel.
        if (a == 0 && b == 0) revert E11();
        // Sanity ceiling on max weight (matches PublisherGovernance shape).
        uint256 maxWeight = (a * 64 + b * 8) / CONVICTION_SCALE + 1;
        if (maxWeight > 1000) revert E11();
        convictionA = a;
        convictionB = b;
        emit ConvictionCurveSet(a, b);
    }

    /// @notice G-10: owner-only setter for the retune cooldown window.
    ///         Bounded by MAX_RETUNE_COOLDOWN_BLOCKS (~30d). 0 disables.
    ///         Default 0 (testnet posture); production sets a non-zero
    ///         value before any high-impact retune.
    function setRetuneCooldownBlocks(uint256 blocks_) external onlyOwner whenNotFrozen {
        _setRetuneCooldownBlocks(blocks_);
    }

    function setConvictionLockups(uint256[9] calldata l) external onlyOwner whenNotFrozen {
        for (uint256 i = 0; i < 9; i++) {
            if (l[i] > MAX_LOCKUP_BLOCKS) revert E11();
            convictionLockup[i] = l[i];
        }
        emit ConvictionLockupsSet(l);
    }

    // ── Internal weight / lockup ────────────────────────────────────────
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

    // ── Proposal lifecycle ──────────────────────────────────────────────
    function propose(address relay, uint8 reasonCode, bytes32 evidenceHash)
        external
        payable
        whenNotPaused
        whenNotFrozen
        returns (uint256 proposalId)
    {
        if (relay == address(0)) revert E00();
        if (evidenceHash == bytes32(0)) revert E00();
        if (reasonCode == 0 || reasonCode > 4) revert E68();
        if (msg.value != proposeBond) revert E11();
        // Anti-laundering: a relay cannot propose against itself.
        if (msg.sender == relay) revert E18();

        proposalId = nextProposalId++;
        _proposals[proposalId] = Proposal({
            relay: relay,
            proposer: msg.sender,
            reasonCode: reasonCode,
            evidenceHash: evidenceHash,
            createdBlock: block.number,
            ayeWeighted: 0,
            nayWeighted: 0,
            firstNayBlock: 0,
            bond: msg.value,
            resolved: false
        });
        proposalConvictionA[proposalId] = convictionA;
        proposalConvictionB[proposalId] = convictionB;

        emit ProposalCreated(proposalId, relay, msg.sender, reasonCode, evidenceHash);
    }

    function vote(uint256 proposalId, bool aye, uint8 conviction)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (msg.value == 0) revert E11();
        if (conviction > MAX_CONVICTION) revert E40();

        Proposal storage p = _proposals[proposalId];
        if (p.createdBlock == 0) revert E01();
        if (p.resolved) revert E41();

        Vote storage v = _votes[proposalId][msg.sender];
        if (!_voterTracked[proposalId][msg.sender]) {
            _voterTracked[proposalId][msg.sender] = true;
            _proposalVoters[proposalId].push(msg.sender);
        }

        if (v.direction != 0) {
            uint256 existingWeight = v.lockAmount * _weight(proposalId, v.conviction);
            if (v.direction == 1) {
                p.ayeWeighted -= existingWeight;
            } else {
                p.nayWeighted -= existingWeight;
            }
            if (block.number < v.lockedUntilBlock) revert E42();
            uint256 refundAmount = v.lockAmount;
            emit VoteRefunded(proposalId, msg.sender, refundAmount);
            _safeSend(msg.sender, refundAmount);
        }

        uint256 weight = msg.value * _weight(proposalId, conviction);
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

    function withdrawVote(uint256 proposalId) external nonReentrant whenNotFrozen {
        Vote storage v = _votes[proposalId][msg.sender];
        if (v.direction == 0) revert E01();
        if (block.number < v.lockedUntilBlock) revert E42();

        Proposal storage p = _proposals[proposalId];
        uint256 weight = v.lockAmount * _weight(proposalId, v.conviction);
        if (v.direction == 1) p.ayeWeighted -= weight;
        else                  p.nayWeighted -= weight;

        uint256 amount = v.lockAmount;
        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        emit VoteWithdrawn(proposalId, msg.sender, amount);
        _safeSend(msg.sender, amount);
    }

    function resolve(uint256 proposalId) external nonReentrant whenNotPaused whenNotFrozen {
        Proposal storage p = _proposals[proposalId];
        if (p.createdBlock == 0) revert E01();
        if (p.resolved) revert E41();

        if (p.firstNayBlock > 0) {
            if (block.number < p.firstNayBlock + minGraceBlocks) revert E43();
        }

        p.resolved = true;

        bool fraudUpheld = p.ayeWeighted > p.nayWeighted && p.ayeWeighted >= quorum;
        uint256 slashAmount = 0;

        if (fraudUpheld) {
            (uint256 active,,) = relayStake.stakeOf(p.relay);
            slashAmount = (active * uint256(slashAmountBps)) / 10000;

            if (slashAmount > 0) {
                // Receive funds into this contract; distribute below.
                slashAmount = relayStake.slash(p.relay, slashAmount, address(this), p.reasonCode);

                if (slashAmount > 0) {
                    uint256 distributed = 0;
                    uint256 cBonus = (slashAmount * uint256(challengerBonusBps)) / 10000;
                    uint256 tCut   = (slashAmount * uint256(treasuryBps)) / 10000;

                    if (cBonus > 0) {
                        _queueGovPayout(p.proposer, cBonus);
                        distributed += cBonus;
                        emit GovPayoutQueued(p.proposer, cBonus, "challenger bonus");
                    }
                    if (tCut > 0 && treasury != address(0)) {
                        _queueGovPayout(treasury, tCut);
                        distributed += tCut;
                        emit GovPayoutQueued(treasury, tCut, "treasury cut");
                    }
                    // Residue → contract treasuryBalance (owner sweep).
                    treasuryBalance += (slashAmount - distributed);
                }
            }
        }

        // Bond accounting: quorum reached → refund proposer; otherwise forfeit.
        bool quorumReached = p.ayeWeighted >= quorum || p.nayWeighted >= quorum;
        uint256 bond = p.bond;
        p.bond = 0;
        if (bond > 0) {
            address recipient = quorumReached ? p.proposer : owner();
            _queueGovPayout(recipient, bond);
            emit ProposeBondQueued(recipient, bond, quorumReached);
        }

        emit ProposalResolved(proposalId, p.relay, fraudUpheld, slashAmount);
    }

    function sweepTreasury() external nonReentrant whenNotFrozen {
        uint256 amount = treasuryBalance;
        if (amount == 0) revert E03();
        treasuryBalance = 0;
        _queueGovPayout(owner(), amount);
        emit TreasurySwept(owner(), amount);
        emit GovPayoutQueued(owner(), amount, "treasury sweep");
    }

    function claimGovPayout() external nonReentrant whenNotFrozen {
        _claim(msg.sender, msg.sender);
    }

    function claimGovPayoutTo(address recipient) external nonReentrant whenNotFrozen {
        if (recipient == address(0)) revert E00();
        _claim(msg.sender, recipient);
    }

    function _claim(address account, address recipient) internal {
        uint256 amount = pendingGovPayout[account];
        if (amount == 0) revert E03();
        pendingGovPayout[account] = 0;
        emit GovPayoutClaimed(account, recipient, amount);
        _safeSend(recipient, amount);
    }

    // ── Views ───────────────────────────────────────────────────────────
    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVote(uint256 proposalId, address voter) external view returns (Vote memory) {
        return _votes[proposalId][voter];
    }

    function convictionWeight(uint8 conviction) external view returns (uint256) {
        if (conviction > MAX_CONVICTION) revert E40();
        uint256 cu = uint256(conviction);
        return (convictionA * cu * cu + convictionB * cu) / CONVICTION_SCALE + 1;
    }

    function convictionLockupBlocks(uint8 conviction) external view returns (uint256) {
        if (conviction > MAX_CONVICTION) revert E40();
        return _lockup(conviction);
    }

    // ── Upgrade migration (config + settled payout queue; native sweep) ──

    function govPayoutHolderCount() external view returns (uint256) { return _govPayoutHolders.length; }
    function govPayoutHolderAt(uint256 i) external view returns (address) { return _govPayoutHolders[i]; }
    function getProposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }
    function proposalVoterCount(uint256 id) external view returns (uint256) { return _proposalVoters[id].length; }
    function proposalVoterAt(uint256 id, uint256 i) external view returns (address) { return _proposalVoters[id][i]; }

    /// @dev Copy governance params + treasury accounting + settled pending
    ///      payouts from a frozen predecessor. In-flight proposals/votes are
    ///      NOT migrated — they must be resolved (refunds → pendingGovPayout)
    ///      before migration. Refs (relayStake / pauseRegistry) are re-wired.
    function _migrate(address oldContract) internal override {
        DatumRelayGovernance old = DatumRelayGovernance(payable(oldContract));
        quorum = old.quorum();
        minGraceBlocks = old.minGraceBlocks();
        proposeBond = old.proposeBond();
        slashAmountBps = old.slashAmountBps();
        challengerBonusBps = old.challengerBonusBps();
        treasuryBps = old.treasuryBps();
        convictionA = old.convictionA();
        convictionB = old.convictionB();
        for (uint256 i = 0; i < 9; i++) convictionLockup[i] = old.convictionLockup(i);
        treasury = old.treasury();
        treasuryBalance = old.treasuryBalance();
        // In-flight proposals + their time-locked conviction votes (can't drain).
        nextProposalId = old.nextProposalId();
        for (uint256 id = 1; id < nextProposalId; id++) {
            _proposals[id] = old.getProposal(id);
            proposalConvictionA[id] = old.proposalConvictionA(id);
            proposalConvictionB[id] = old.proposalConvictionB(id);
            uint256 vn = old.proposalVoterCount(id);
            for (uint256 j = 0; j < vn; j++) {
                address voter = old.proposalVoterAt(id, j);
                _votes[id][voter] = old.getVote(id, voter);
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

    /// @notice Sweep native DOT (settled payouts + treasury residue) to a
    ///         successor during an upgrade. Governance-gated, frozen-only, one-shot.
    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumRelayGovernance(payable(successor)).acceptMigration{value: bal}();
    }

    function acceptMigration() external payable {
        require(msg.sender == migrationSource, "not-source");
    }
}
