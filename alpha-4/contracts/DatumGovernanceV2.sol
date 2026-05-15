// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumActivationBondsMinimal.sol";

/// @title DatumGovernanceV2
/// @notice Dynamic conviction-based governance: vote/withdraw/re-vote, campaign evaluation,
///         and symmetric slash (losing side pays configurable BPS on resolution).
///
///         Alpha-2 changes:
///           - Termination delegates to DatumCampaignLifecycle (not Campaigns directly).
///           - getCampaignForSettlement returns 4 values (no remainingBudget).
///           - Conviction scales logarithmically with lock time: each step up costs
///             disproportionately more locked time per unit of voting weight gained.
///
///         Conviction table (6s blocks, 14,400 blocks/day):
///           Low levels are cheap (casual participation), upper levels have
///           escalating lockup cost per unit of weight (true conviction).
///           0 →  1x weight,    0d lock (        0 blocks) — instant withdraw
///           1 →  2x weight,    1d lock (   14,400 blocks) — low-risk entry
///           2 →  3x weight,    3d lock (   43,200 blocks) — weekend lock
///           3 →  4x weight,    7d lock (  100,800 blocks) — one week
///           4 →  6x weight,   21d lock (  302,400 blocks) — three weeks
///           5 →  9x weight,   90d lock (1,296,000 blocks) — quarter
///           6 → 14x weight,  180d lock (2,592,000 blocks) — half year
///           7 → 18x weight,  270d lock (3,888,000 blocks) — nine months
///           8 → 21x weight,  365d lock (5,256,000 blocks) — full year
contract DatumGovernanceV2 is PaseoSafeSender, DatumOwnable {
    uint8 public constant MAX_CONVICTION = 8;

    // -------------------------------------------------------------------------
    // Conviction lookup — GOVERNABLE quadratic curve + governable lockup array
    //
    //   weight(c) = (convictionA * c² + convictionB * c) / CONVICTION_SCALE + 1
    //
    // Defaults (A=25, B=50, SCALE=100) → weight(0)=1, weight(8)=21
    //   matching the old step-function endpoint while delivering a smooth
    //   quadratic ramp. Governance can re-tune any time via setConvictionCurve.
    //
    //   Lockup is an 9-element array (one per conviction level). Governance
    //   can rewrite it wholesale via setConvictionLockups, but each element is
    //   bounded by MAX_LOCKUP_BLOCKS to prevent griefing voters with absurd
    //   locks.
    // -------------------------------------------------------------------------
    uint256 public constant CONVICTION_SCALE = 100;
    /// @notice Upper bound on any single conviction-level lockup. 2 years at 6s/block.
    uint256 public constant MAX_LOCKUP_BLOCKS = 10_512_000;

    uint256 public convictionA;       // quadratic coefficient (× CONVICTION_SCALE)
    uint256 public convictionB;       // linear coefficient (× CONVICTION_SCALE)
    uint256[9] public convictionLockup;

    event ConvictionCurveSet(uint256 a, uint256 b);
    event ConvictionLockupsSet(uint256[9] lockups);

    /// @notice M-2 audit fix: per-campaign-proposal snapshot of conviction
    ///         coefficients. Populated lazily on the first vote per campaignId
    ///         so governance retunes can't reweight in-flight proposals.
    mapping(uint256 => uint256) public proposalConvictionA;
    mapping(uint256 => uint256) public proposalConvictionB;

    function _weight(uint256 campaignId, uint8 c) internal view returns (uint256) {
        uint256 cu = uint256(c);
        uint256 a = proposalConvictionA[campaignId];
        uint256 b = proposalConvictionB[campaignId];
        if (a == 0 && b == 0) {
            // Pre-snapshot or never-voted proposal — use live curve.
            a = convictionA;
            b = convictionB;
        }
        return (a * cu * cu + b * cu) / CONVICTION_SCALE + 1;
    }

    function _lockup(uint8 c) internal view returns (uint256) {
        return convictionLockup[c];
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    address public campaigns;
    IDatumCampaignLifecycle public lifecycle;
    IDatumPauseRegistry public immutable pauseRegistry;
    /// @notice Optimistic-activation gateway. When wired, votes on Pending
    ///         campaigns require a contestation (challenger bond posted). If
    ///         unset (address(0)), legacy always-on Pending voting applies —
    ///         keeps old deployments and tests working.
    IDatumActivationBondsMinimal public activationBonds;

    uint256 public quorumWeighted;
    uint256 public slashBps;
    uint256 public terminationQuorum;
    uint256 public baseGraceBlocks;    // minimum cooldown before termination
    uint256 public gracePerQuorum;     // additional blocks per quorum-unit of total weight
    uint256 public maxGraceBlocks;     // cap on total grace period

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Vote {
        uint8 direction;          // 0=none, 1=aye, 2=nay
        uint256 lockAmount;
        uint8 conviction;         // 0-8
        uint256 lockedUntilBlock;
        // Commit-reveal extension: when the contested-Pending flow is used,
        // commitHash is non-zero between commit and reveal. revealVote()
        // verifies the hash, populates direction/conviction, and zeroes
        // commitHash to signal a completed reveal. Non-revealers leave
        // commitHash non-zero and direction == 0 — sweepUnrevealed() then
        // forfeits their lockAmount to the slash pool.
        bytes32 commitHash;
    }

    mapping(uint256 => uint256) public ayeWeighted;
    mapping(uint256 => uint256) public nayWeighted;
    mapping(uint256 => bool) public resolved;
    mapping(uint256 => uint256) public slashCollected;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => uint256) public firstNayBlock;

    // ---- Commit-reveal window state ------------------------------------------
    // Applied only to contested-Pending votes (status==0 with ActivationBonds
    // wired + isContested=true). Active demote votes keep the existing
    // open-tally vote() flow so a malicious campaign can be stopped quickly.
    struct CommitRevealWindow {
        uint64 commitDeadline;
        uint64 revealDeadline;
        bool   opened;
    }
    mapping(uint256 => CommitRevealWindow) public commitRevealWindow;

    /// @notice Blocks allotted to the commit phase. Governable, default 14400
    ///         (~1 day at 6s/block).
    uint64 public commitBlocks;
    /// @notice Blocks allotted to the reveal phase. Governable, default 14400.
    uint64 public revealBlocks;

    /// @notice Upper bound on either phase length — caps total grief window.
    uint64 public constant MAX_PHASE_BLOCKS = 1_209_600; // ~84 days

    event CommitRevealWindowOpened(uint256 indexed campaignId, uint64 commitDeadline, uint64 revealDeadline);
    event VoteCommitted(uint256 indexed campaignId, address indexed voter, bytes32 commitHash, uint256 amount);
    event VoteRevealed(uint256 indexed campaignId, address indexed voter, bool aye, uint8 conviction);
    event UnrevealedSwept(uint256 indexed campaignId, address indexed voter, uint256 amount);
    event CommitRevealPhasesSet(uint64 commitBlocks, uint64 revealBlocks);
    // AUDIT-011: track last block where a vote changed the decisive side, for symmetric grace period
    mapping(uint256 => uint256) public lastSignificantVoteBlock;

    // SM-5: Snapshot winning weight at resolution time (not finalization)
    mapping(uint256 => uint256) public resolvedWinningWeight;

    // ---- Slash distribution state (merged from GovernanceSlash) ----
    uint256 public constant SWEEP_DEADLINE_BLOCKS = 5256000; // ~365 days

    mapping(uint256 => uint256) public winningWeight;
    mapping(uint256 => bool) public slashFinalized;
    mapping(uint256 => uint256) public slashFinalizedBlock;
    mapping(uint256 => mapping(address => bool)) public slashClaimed;
    mapping(uint256 => uint256) public totalSlashClaimed;

    /// @dev G-M3: pending sweep amount queued for owner pull. sweepSlashPool no
    ///      longer pushes to owner — a misconfigured owner would otherwise
    ///      brick the sweep and strand the unclaimed slash.
    uint256 public pendingOwnerSweep;
    event OwnerSweepQueued(uint256 indexed campaignId, uint256 amount);
    event OwnerSweepClaimed(address indexed recipient, uint256 amount);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event VoteCast(uint256 indexed campaignId, address indexed voter, bool aye, uint256 amount, uint8 conviction);
    event VoteWithdrawn(uint256 indexed campaignId, address indexed voter, uint256 returned, uint256 slashed);
    event CampaignEvaluated(uint256 indexed campaignId, uint8 result);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _campaigns,
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _terminationQuorum,
        uint256 _baseGrace,
        uint256 _gracePerQuorum,
        uint256 _maxGrace,
        address _pauseRegistry
    ) {
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        require(_maxGrace >= _baseGrace, "E00");
        // G-M2: cap slashBps below 100% so losing voters can always retrieve a
        // non-zero refund — `withdraw()` reverts with E58 when refund == 0.
        require(_slashBps < 10000, "E11");
        campaigns = _campaigns;
        quorumWeighted = _quorum;
        slashBps = _slashBps;
        terminationQuorum = _terminationQuorum;
        baseGraceBlocks = _baseGrace;
        gracePerQuorum = _gracePerQuorum;
        maxGraceBlocks = _maxGrace;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);

        // Default conviction curve: weight(c) = (25c² + 50c)/100 + 1
        //   c=0 → 1x, c=4 → 7x, c=8 → 21x (matches old step-function endpoint).
        convictionA = 25;
        convictionB = 50;

        // Default commit-reveal: 1 day commit + 1 day reveal (6s blocks).
        commitBlocks = 14400;
        revealBlocks = 14400;
        // Default lockup schedule (same as legacy step function, ≤ MAX_LOCKUP_BLOCKS).
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

    /// @dev Accept ETH from contract-originated transfers (e.g. BudgetLedger slash fraction)
    ///      and voter slash deposits held for winner distribution.
    receive() external payable {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev Cypherpunk lock-once: lifecycle is the target of terminate/demote
    ///      proposals. Hot-swap could redirect governance actions to a no-op
    ///      lifecycle that swallows them.
    function setLifecycle(address _lifecycle) external onlyOwner {
        require(_lifecycle != address(0), "E00");
        require(address(lifecycle) == address(0), "already set");
        emit ContractReferenceChanged("lifecycle", address(lifecycle), _lifecycle);
        lifecycle = IDatumCampaignLifecycle(_lifecycle);
    }

    /// @dev Cypherpunk lock-once. In the ladder, this is wired once to the
    ///      Router and frozen — Phase transitions happen at the Router, not by
    ///      re-pointing the governance contracts.
    function setCampaigns(address _campaigns) external onlyOwner {
        require(_campaigns != address(0), "E00");
        require(campaigns == address(0), "already set");
        emit ContractReferenceChanged("campaigns", campaigns, _campaigns);
        campaigns = _campaigns;
    }

    /// @dev Cypherpunk lock-once. Once wired, voting on Pending campaigns is
    ///      restricted to contested cases — uncontested campaigns activate
    ///      via the ActivationBonds optimistic path instead. Hot-swap to a
    ///      contract that always reports `isContested=true` would re-open
    ///      the legacy bandwagon-prone vote path.
    function setActivationBonds(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(activationBonds) == address(0), "already set");
        emit ContractReferenceChanged("activationBonds", address(activationBonds), addr);
        activationBonds = IDatumActivationBondsMinimal(addr);
    }

    // -------------------------------------------------------------------------
    // Governable gating parameters (all owner-only — in the ladder, owner is
    // the Timelock/Router, so changes traverse the protocol's governance flow).
    // -------------------------------------------------------------------------

    event QuorumWeightedSet(uint256 value);
    event SlashBpsSet(uint256 value);
    event TerminationQuorumSet(uint256 value);
    event GraceParamsSet(uint256 baseGrace, uint256 gracePerQuorum, uint256 maxGrace);

    function setQuorumWeighted(uint256 v) external onlyOwner {
        quorumWeighted = v;
        emit QuorumWeightedSet(v);
    }

    function setSlashBps(uint256 v) external onlyOwner {
        require(v < 10000, "E11");
        slashBps = v;
        emit SlashBpsSet(v);
    }

    function setTerminationQuorum(uint256 v) external onlyOwner {
        terminationQuorum = v;
        emit TerminationQuorumSet(v);
    }

    function setGraceParams(uint256 _baseGrace, uint256 _gracePerQuorum, uint256 _maxGrace) external onlyOwner {
        require(_maxGrace >= _baseGrace, "E11");
        baseGraceBlocks = _baseGrace;
        gracePerQuorum = _gracePerQuorum;
        maxGraceBlocks = _maxGrace;
        emit GraceParamsSet(_baseGrace, _gracePerQuorum, _maxGrace);
    }

    /// @notice Update the quadratic conviction curve coefficients.
    ///         weight(c) = (a*c² + b*c) / CONVICTION_SCALE + 1
    function setConvictionCurve(uint256 a, uint256 b) external onlyOwner {
        // Sanity: at MAX_CONVICTION the weight should fit in a reasonable
        // value. Cap at 1000x effective weight to prevent governance setting
        // an absurd coefficient that makes a single super-conviction vote
        // dominate quorum forever.
        uint256 maxWeight = (a * 64 + b * 8) / CONVICTION_SCALE + 1;
        require(maxWeight <= 1000, "E11");
        convictionA = a;
        convictionB = b;
        emit ConvictionCurveSet(a, b);
    }

    /// @notice Update the per-conviction-level lockup schedule. Pass all 9
    ///         values at once. Each capped at MAX_LOCKUP_BLOCKS to prevent
    ///         griefing voters with absurdly long locks.
    /// @notice Adjust the commit and reveal phase lengths. Each bounded to
    ///         MAX_PHASE_BLOCKS so governance can't grief voters with absurd
    ///         windows (mirrors the conviction-lockup bound).
    function setCommitRevealPhases(uint64 _commit, uint64 _reveal) external onlyOwner {
        require(_commit > 0 && _commit <= MAX_PHASE_BLOCKS, "E11");
        require(_reveal > 0 && _reveal <= MAX_PHASE_BLOCKS, "E11");
        commitBlocks = _commit;
        revealBlocks = _reveal;
        emit CommitRevealPhasesSet(_commit, _reveal);
    }

    function setConvictionLockups(uint256[9] calldata l) external onlyOwner {
        for (uint256 i = 0; i < 9; i++) {
            require(l[i] <= MAX_LOCKUP_BLOCKS, "E11");
            convictionLockup[i] = l[i];
        }
        emit ConvictionLockupsSet(l);
    }

    // -------------------------------------------------------------------------
    // Voting
    // -------------------------------------------------------------------------

    function vote(uint256 campaignId, bool aye, uint8 conviction) external payable nonReentrant {
        require(!pauseRegistry.pausedGovernance(), "P");
        require(conviction <= MAX_CONVICTION, "E40");
        require(msg.value > 0, "E41");

        Vote storage v = _votes[campaignId][msg.sender];
        // G-L1: AUDIT-001 conviction floor was dead code — withdraw() resets
        //       v.conviction to 0, and re-vote is gated on v.direction == 0,
        //       so v.conviction is always 0 on this path. The direction-zero
        //       check below subsumes the floor protection.
        require(v.direction == 0, "E42");

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        require(status == 0 || status == 1, "E43");

        // Optimistic-activation gate: when the ActivationBonds gateway is
        // wired, the contested-Pending vote path MUST go through commit-reveal
        // (commitVote/revealVote). The legacy open-tally vote() is reserved
        // for the Active demote path, where speed beats signal quality and a
        // separate emergency-mute mechanism handles the bandwagon concern.
        if (status == 0 && address(activationBonds) != address(0)) {
            revert("E51"); // use commitVote/revealVote
        }

        // M-2: snapshot the conviction curve on the first vote for this
        //      campaign. Subsequent votes on the same proposal reuse the
        //      snapshot, even if governance retunes the curve mid-vote-window.
        if (proposalConvictionA[campaignId] == 0 && proposalConvictionB[campaignId] == 0) {
            proposalConvictionA[campaignId] = convictionA;
            proposalConvictionB[campaignId] = convictionB;
        }

        uint256 weight = msg.value * _weight(campaignId, conviction);
        uint256 lockup = _lockup(conviction);

        v.direction = aye ? 1 : 2;
        v.lockAmount = msg.value;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;

        if (aye) {
            ayeWeighted[campaignId] += weight;
        } else {
            nayWeighted[campaignId] += weight;
            if (firstNayBlock[campaignId] == 0) {
                firstNayBlock[campaignId] = block.number;
            }
        }

        // AUDIT-011: record last decisive-side vote block for symmetric grace period
        lastSignificantVoteBlock[campaignId] = block.number;

        emit VoteCast(campaignId, msg.sender, aye, msg.value, conviction);
    }

    // -------------------------------------------------------------------------
    // Commit-reveal (contested-Pending votes only)
    // -------------------------------------------------------------------------
    //
    //   Two-phase voting on contested campaign activation defeats bandwagoning
    //   and tally-anchoring: voters submit a hash of their (direction, conviction,
    //   salt, voter, campaignId) tuple during the commit window with their
    //   locked stake, then reveal cleartext in a later window. The running
    //   tally is invisible until reveal begins.
    //
    //   Non-revealers full-forfeit their stake to the slash pool via
    //   sweepUnrevealed(). This is the deliberate cost of commit-reveal:
    //   salt loss = stake loss. Voters who fear loss should reveal early.
    //
    //   The window opens lazily on the first commit. Reveal begins when
    //   commitDeadline is passed and ends at revealDeadline.

    function _hashCommit(
        uint256 campaignId,
        address voter,
        bool aye,
        uint8 conviction,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(campaignId, voter, aye, conviction, salt));
    }

    function _openCommitRevealWindow(uint256 campaignId) internal {
        CommitRevealWindow storage w = commitRevealWindow[campaignId];
        if (w.opened) return;
        w.opened = true;
        w.commitDeadline = uint64(block.number) + commitBlocks;
        w.revealDeadline = w.commitDeadline + revealBlocks;
        emit CommitRevealWindowOpened(campaignId, w.commitDeadline, w.revealDeadline);
    }

    function commitVote(uint256 campaignId, bytes32 hash) external payable nonReentrant {
        require(!pauseRegistry.pausedGovernance(), "P");
        require(hash != bytes32(0), "E40");
        require(msg.value > 0, "E41");

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        require(status == 0, "E43"); // commit-reveal only for Pending
        // ActivationBonds must be wired and the campaign must be contested.
        // Without contestation, the campaign auto-activates via the bond path
        // and never reaches governance.
        require(address(activationBonds) != address(0), "E51");
        require(activationBonds.isContested(campaignId), "E95");

        // Snapshot conviction curve on the first commit per campaign — keeps
        // mid-vote retunes from reweighting in-flight proposals (mirrors M-2
        // logic in vote()).
        if (proposalConvictionA[campaignId] == 0 && proposalConvictionB[campaignId] == 0) {
            proposalConvictionA[campaignId] = convictionA;
            proposalConvictionB[campaignId] = convictionB;
        }

        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction == 0 && v.commitHash == bytes32(0), "E42"); // already committed/voted

        _openCommitRevealWindow(campaignId);
        CommitRevealWindow storage w = commitRevealWindow[campaignId];
        require(block.number <= w.commitDeadline, "E51"); // commit window closed

        v.commitHash = hash;
        v.lockAmount = msg.value;

        emit VoteCommitted(campaignId, msg.sender, hash, msg.value);
    }

    function revealVote(
        uint256 campaignId,
        bool aye,
        uint8 conviction,
        bytes32 salt
    ) external nonReentrant {
        require(!pauseRegistry.pausedGovernance(), "P");
        require(conviction <= MAX_CONVICTION, "E40");

        CommitRevealWindow storage w = commitRevealWindow[campaignId];
        require(w.opened, "E52"); // window never opened
        require(block.number > w.commitDeadline, "E51"); // still in commit phase
        require(block.number <= w.revealDeadline, "E51"); // reveal window closed

        Vote storage v = _votes[campaignId][msg.sender];
        require(v.commitHash != bytes32(0), "E44"); // never committed
        require(v.direction == 0, "E42"); // already revealed

        bytes32 expected = _hashCommit(campaignId, msg.sender, aye, conviction, salt);
        require(expected == v.commitHash, "E53"); // hash mismatch

        uint256 weight = v.lockAmount * _weight(campaignId, conviction);
        uint256 lockup = _lockup(conviction);

        v.direction = aye ? 1 : 2;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;
        v.commitHash = bytes32(0); // mark revealed

        if (aye) {
            ayeWeighted[campaignId] += weight;
        } else {
            nayWeighted[campaignId] += weight;
            if (firstNayBlock[campaignId] == 0) {
                firstNayBlock[campaignId] = block.number;
            }
        }
        lastSignificantVoteBlock[campaignId] = block.number;

        emit VoteRevealed(campaignId, msg.sender, aye, conviction);
    }

    /// @notice Forfeit an unrevealed commit's stake to the slash pool.
    ///         Permissionless after revealDeadline. The full lockAmount moves
    ///         to slashCollected[campaignId] for distribution to revealers on
    ///         the winning side.
    function sweepUnrevealed(uint256 campaignId, address voter) external nonReentrant {
        CommitRevealWindow storage w = commitRevealWindow[campaignId];
        require(w.opened, "E52");
        require(block.number > w.revealDeadline, "E51"); // reveal still open

        Vote storage v = _votes[campaignId][voter];
        require(v.commitHash != bytes32(0), "E44"); // already revealed or no commit
        require(v.direction == 0, "E42"); // safety: revealed votes are zeroed

        uint256 forfeit = v.lockAmount;
        require(forfeit > 0, "E03");

        v.commitHash = bytes32(0);
        v.lockAmount = 0;
        slashCollected[campaignId] += forfeit;

        emit UnrevealedSwept(campaignId, voter, forfeit);
    }

    // -------------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------------

    function withdraw(uint256 campaignId) external nonReentrant {
        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction != 0, "E44");
        require(block.number >= v.lockedUntilBlock, "E45");

        uint256 weight = v.lockAmount * _weight(campaignId, v.conviction);
        uint256 slash = 0;

        if (v.direction == 1) {
            ayeWeighted[campaignId] -= weight;
        } else {
            nayWeighted[campaignId] -= weight;
        }

        if (resolved[campaignId]) {
            slash = _computeSlash(campaignId, v.direction, v.lockAmount);
            if (slash > 0) {
                slashCollected[campaignId] += slash;
            }
        }

        uint256 refund = v.lockAmount - slash;
        require(refund > 0, "E58");

        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        emit VoteWithdrawn(campaignId, msg.sender, refund, slash);
        _safeSend(msg.sender, refund);
    }

    // -------------------------------------------------------------------------
    // Evaluation
    // -------------------------------------------------------------------------

    function evaluateCampaign(uint256 campaignId) external {
        require(!pauseRegistry.pausedGovernance(), "P");
        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);

        uint256 total = ayeWeighted[campaignId] + nayWeighted[campaignId];

        if (status == 0) {
            // Pending: two paths — activation (aye wins) or termination (nay wins after grace)
            // Commit-reveal gate: if a window was opened, no evaluation until
            // reveal phase has closed. Prevents an early evaluator from
            // resolving the vote before all committers have revealed.
            CommitRevealWindow storage w = commitRevealWindow[campaignId];
            if (w.opened) {
                require(block.number > w.revealDeadline, "E51");
            }
            require(total >= quorumWeighted, "E46");
            bool ayeWins = ayeWeighted[campaignId] * 10000 > total * 5000;
            bool nayWins = nayWeighted[campaignId] * 10000 >= total * 5000
                        && nayWeighted[campaignId] >= terminationQuorum;

            if (ayeWins) {
                // AUDIT-011: symmetric grace period — aye activation requires same cooldown as nay termination
                uint256 ayeGrace = baseGraceBlocks;
                if (quorumWeighted > 0) {
                    ayeGrace += total * gracePerQuorum / quorumWeighted;
                }
                if (ayeGrace > maxGraceBlocks) ayeGrace = maxGraceBlocks;
                uint256 lastVote = lastSignificantVoteBlock[campaignId];
                require(lastVote == 0 || ayeGrace == 0 || block.number >= lastVote + ayeGrace, "E53");
                IDatumCampaignsMinimal(campaigns).activateCampaign(campaignId);
                emit CampaignEvaluated(campaignId, 1);
            } else if (nayWins) {
                // G-M4: symmetric grace using `lastSignificantVoteBlock` (AUDIT-011),
                // matching the aye-wins path. firstNayBlock was the prior anchor but
                // never reset on full nay withdrawal, allowing earlier-than-intended
                // termination after a reset+revote cycle.
                uint256 grace = baseGraceBlocks;
                if (quorumWeighted > 0) {
                    grace += total * gracePerQuorum / quorumWeighted;
                }
                if (grace > maxGraceBlocks) grace = maxGraceBlocks;
                uint256 lastVote = lastSignificantVoteBlock[campaignId];
                require(lastVote == 0 || grace == 0 || block.number >= lastVote + grace, "E53");
                lifecycle.terminateCampaign(campaignId);
                resolved[campaignId] = true;
                resolvedWinningWeight[campaignId] = nayWeighted[campaignId];
                emit CampaignEvaluated(campaignId, 4);
            } else {
                revert("E50");
            }
        } else if (status == 1 || status == 2) {
            // Active/Paused: nay ≥ 50% with quorum → demote to Pending (anti-grief grace deferred)
            require(total >= quorumWeighted, "E46");
            require(nayWeighted[campaignId] * 10000 >= total * 5000, "E48");
            lifecycle.demoteCampaign(campaignId);
            emit CampaignEvaluated(campaignId, 5); // result 5 = demoted
        } else if (status == 3) {
            // Completed -> mark resolved
            require(!resolved[campaignId], "E49");
            resolved[campaignId] = true;
            // SM-5: Snapshot winning weight (aye won → completed)
            resolvedWinningWeight[campaignId] = ayeWeighted[campaignId];
            emit CampaignEvaluated(campaignId, 3);
        } else if (status == 4 && !resolved[campaignId]) {
            // Terminated -> mark resolved (e.g., terminated via lifecycle directly)
            resolved[campaignId] = true;
            resolvedWinningWeight[campaignId] = nayWeighted[campaignId];
            // Audit-5 H4: if terminated via a direct high-tier proposal
            // (bypassing the aye/nay vote), nayWeighted is 0 and the
            // slashCollected pool would otherwise be unclaimable.
            // Route it to ownerSweep so it doesn't strand.
            if (nayWeighted[campaignId] == 0) {
                _routeStuckPoolToOwnerSweep(campaignId);
            }
            emit CampaignEvaluated(campaignId, 4);
        } else if (status == 5 && !resolved[campaignId]) {
            // Audit-5 H4: Expired — campaign timed out without a vote
            // resolution. Revealed voters recover their stake via
            // withdraw() at lockup expiry. Non-revealer forfeits (in
            // slashCollected) have no winning side to distribute to;
            // route them to ownerSweep so the pool doesn't permanently
            // strand.
            resolved[campaignId] = true;
            _routeStuckPoolToOwnerSweep(campaignId);
            emit CampaignEvaluated(campaignId, 6); // result 6 = expired
        } else {
            revert("E50");
        }
    }

    /// @dev Audit-5 H4 helper: marks slashCollected as fully consumed and
    ///      queues the residue for owner pull. Used by resolution paths
    ///      that have no winning side to distribute the pool to.
    function _routeStuckPoolToOwnerSweep(uint256 campaignId) internal {
        uint256 pool = slashCollected[campaignId];
        if (pool == 0) return;
        uint256 already = totalSlashClaimed[campaignId];
        if (already >= pool) return;
        uint256 remaining = pool - already;
        totalSlashClaimed[campaignId] = pool;
        pendingOwnerSweep += remaining;
        emit OwnerSweepQueued(campaignId, remaining);
    }

    // -------------------------------------------------------------------------
    // Slash distribution (merged from GovernanceSlash)
    // -------------------------------------------------------------------------

    /// @notice Finalize slash using weight snapshot from resolution time (SM-5)
    function finalizeSlash(uint256 campaignId) external {
        require(!slashFinalized[campaignId], "E59");
        require(resolved[campaignId], "E60");

        uint256 w = resolvedWinningWeight[campaignId];
        require(w > 0, "E61");

        winningWeight[campaignId] = w;
        slashFinalized[campaignId] = true;
        slashFinalizedBlock[campaignId] = block.number;
    }

    /// @notice Winner claims proportional share of collected slash
    function claimSlashReward(uint256 campaignId) external nonReentrant {
        require(slashFinalized[campaignId], "E54");
        require(!slashClaimed[campaignId][msg.sender], "E55");

        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction != 0, "E44");
        require(block.number >= v.lockedUntilBlock, "E45");

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        require(status == 3 || status == 4, "E60"); // 3=Completed, 4=Terminated
        bool winner = (status == 3 && v.direction == 1)
                   || (status == 4 && v.direction == 2);
        require(winner, "E56");

        uint256 voterWeight = v.lockAmount * _weight(campaignId, v.conviction);
        uint256 pool = slashCollected[campaignId];
        require(winningWeight[campaignId] > 0, "E61");
        uint256 share = Math.mulDiv(pool, voterWeight, winningWeight[campaignId]);
        require(share > 0, "E61");

        slashClaimed[campaignId][msg.sender] = true;
        totalSlashClaimed[campaignId] += share;

        require(share > 0, "E58");
        _safeSend(msg.sender, share);
    }

    /// @notice Sweep unclaimed slash pool after deadline. Permissionless.
    /// @dev G-M3: queues the residue for owner pull; owner calls
    ///      claimOwnerSweep[To] to actually receive funds.
    function sweepSlashPool(uint256 campaignId) external nonReentrant {
        require(slashFinalized[campaignId], "E54");
        require(block.number >= slashFinalizedBlock[campaignId] + SWEEP_DEADLINE_BLOCKS, "E24");

        uint256 pool = slashCollected[campaignId];
        uint256 remaining = pool - totalSlashClaimed[campaignId];
        require(remaining > 0, "E61");

        totalSlashClaimed[campaignId] += remaining;
        pendingOwnerSweep += remaining;
        emit OwnerSweepQueued(campaignId, remaining);
    }

    /// @notice G-M3: Owner pulls accumulated swept residue to themselves.
    function claimOwnerSweep() external nonReentrant {
        _claimOwnerSweep(msg.sender);
    }

    /// @notice G-M3: Owner pulls accumulated swept residue to a chosen recipient.
    function claimOwnerSweepTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claimOwnerSweep(recipient);
    }

    function _claimOwnerSweep(address recipient) internal {
        require(msg.sender == owner(), "E18");
        uint256 amount = pendingOwnerSweep;
        require(amount > 0, "E03");
        pendingOwnerSweep = 0;
        emit OwnerSweepClaimed(recipient, amount);
        _safeSend(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Internal — slash computation (merged from GovernanceHelper)
    // -------------------------------------------------------------------------

    function _computeSlash(
        uint256 campaignId,
        uint8 voteDirection,
        uint256 lockAmount
    ) internal view returns (uint256 slash) {
        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool loser = (status == 3 && voteDirection == 2)  // Completed + nay voter
                  || (status == 4 && voteDirection == 1);  // Terminated + aye voter
        if (loser) {
            slash = lockAmount * slashBps / 10000;
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getVote(uint256 campaignId, address voter) external view returns (
        uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock
    ) {
        Vote storage v = _votes[campaignId][voter];
        return (v.direction, v.lockAmount, v.conviction, v.lockedUntilBlock);
    }

    /// @notice Returns the weight multiplier under the CURRENT curve.
    ///         In-flight proposals use their snapshotted curve internally.
    function convictionWeight(uint8 conviction) external view returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        uint256 cu = uint256(conviction);
        return (convictionA * cu * cu + convictionB * cu) / CONVICTION_SCALE + 1;
    }

    /// @notice View: claimable slash reward for a voter
    function getClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        if (!slashFinalized[campaignId]) return 0;
        if (slashClaimed[campaignId][voter]) return 0;

        Vote storage v = _votes[campaignId][voter];

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool winner = (status == 3 && v.direction == 1) || (status == 4 && v.direction == 2);
        if (!winner || v.direction == 0) return 0;

        uint256 voterWeight = v.lockAmount * _weight(campaignId, v.conviction);
        uint256 pool = slashCollected[campaignId];
        if (winningWeight[campaignId] == 0) return 0;
        return Math.mulDiv(pool, voterWeight, winningWeight[campaignId]);
    }
}
