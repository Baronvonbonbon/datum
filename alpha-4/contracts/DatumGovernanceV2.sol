// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/IDatumPauseRegistry.sol";

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
    // Conviction lookup — constant arrays
    // Polkadot Hub: 6-second block time, 14,400 blocks/day
    //   0 →  1x /   0d    1 →  2x /   1d   2 →  3x /   3d
    //   3 →  4x /   7d    4 →  6x /  21d   5 →  9x /  90d
    //   6 → 14x / 180d    7 → 18x / 270d   8 → 21x / 365d
    // -------------------------------------------------------------------------

    function _weight(uint8 c) internal pure returns (uint256) {
        uint256[9] memory w = [uint256(1), 2, 3, 4, 6, 9, 14, 18, 21];
        return w[c];
    }

    function _lockup(uint8 c) internal pure returns (uint256) {
        uint256[9] memory l = [uint256(0), 14400, 43200, 100800, 302400, 1296000, 2592000, 3888000, 5256000];
        return l[c];
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    address public campaigns;
    IDatumCampaignLifecycle public lifecycle;
    IDatumPauseRegistry public immutable pauseRegistry;

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
    }

    mapping(uint256 => uint256) public ayeWeighted;
    mapping(uint256 => uint256) public nayWeighted;
    mapping(uint256 => bool) public resolved;
    mapping(uint256 => uint256) public slashCollected;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => uint256) public firstNayBlock;
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

        uint256 weight = msg.value * _weight(conviction);
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
    // Withdrawal
    // -------------------------------------------------------------------------

    function withdraw(uint256 campaignId) external nonReentrant {
        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction != 0, "E44");
        require(block.number >= v.lockedUntilBlock, "E45");

        uint256 weight = v.lockAmount * _weight(v.conviction);
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
            emit CampaignEvaluated(campaignId, 4);
        } else {
            revert("E50");
        }
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

        uint256 voterWeight = v.lockAmount * _weight(v.conviction);
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

    function convictionWeight(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _weight(conviction);
    }

    /// @notice View: claimable slash reward for a voter
    function getClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        if (!slashFinalized[campaignId]) return 0;
        if (slashClaimed[campaignId][voter]) return 0;

        Vote storage v = _votes[campaignId][voter];

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool winner = (status == 3 && v.direction == 1) || (status == 4 && v.direction == 2);
        if (!winner || v.direction == 0) return 0;

        uint256 voterWeight = v.lockAmount * _weight(v.conviction);
        uint256 pool = slashCollected[campaignId];
        if (winningWeight[campaignId] == 0) return 0;
        return Math.mulDiv(pool, voterWeight, winningWeight[campaignId]);
    }
}
