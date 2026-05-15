// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumStakeRoot.sol";

/// @title DatumStakeRootV2
/// @notice Permissionless bonded-reporter Merkle root oracle for ZK Path A.
///         Replaces the owner-managed N-of-M reporter set in V1 with a
///         stake-bonded permissionless mechanism: anyone with ≥
///         reporterMinStake DOT can propose roots; threshold-of-bonded-stake
///         approvers finalize; phantom-leaf fraud is caught by anyone via
///         the commitment registry (registerCommitment).
///
///         Design rationale: see narrative-analysis/proposal-stakeroot-optimistic.md
///         and narrative-analysis/task-stakeroot-v2-implementation.md.
///
///         Three fraud-proof modes (only phantom-leaf is permissionless;
///         balance/exclusion require ZK identity proof — deferred to a
///         follow-up that adds the identity verifier):
///           1. Balance fraud  — leaf claims wrong balance for a real user.
///                               DEFERRED. Needs ZK identity verifier so
///                               challenger proves ownership of commitment.
///           2. Phantom leaf   — tree contains a commitment not in the
///                               registered set. SHIPPED via
///                               challengePhantomLeaf.
///           3. Exclusion      — user's registered commitment is missing.
///                               DEFERRED (same reason as #1).
///
///         The phantom-leaf path alone is meaningful: an attacker can no
///         longer mint Sybil leaves from thin air; every leaf must
///         correspond to a registered commitment, and each commitment
///         registration costs commitmentBond.
contract DatumStakeRootV2 is IDatumStakeRoot, PaseoSafeSender, DatumOwnable {
    // ── Constants (sanity ceilings — params governable up to these) ───────────
    uint256 public constant MAX_APPROVAL_THRESHOLD_BPS = 9900;
    uint64  public constant MAX_CHALLENGE_WINDOW = 1_209_600;  // ~84d @ 6s/block
    uint64  public constant MAX_REPORTER_EXIT_DELAY = 1_209_600;
    uint16  public constant MAX_SLASHED_TO_CHALLENGER_BPS = 10000;
    uint16  public constant MAX_SLASH_APPROVER_BPS = 5000;     // 50% cap
    uint256 public constant LOOKBACK_EPOCHS = 8;

    // ── Reporter set (stake-bonded, permissionless) ───────────────────────────
    struct ReporterStake {
        uint256 amount;
        uint64  joinedAtBlock;
        uint64  exitProposedBlock;   // 0 = active
    }
    mapping(address => ReporterStake) public reporterStake;
    address[] public reporterList;
    mapping(address => uint256) private _reporterIndex;
    uint256 public totalReporterStake;

    // ── Governable parameters ─────────────────────────────────────────────────
    uint256 public reporterMinStake;
    uint64  public reporterExitDelay;
    uint16  public approvalThresholdBps;
    uint64  public challengeWindow;
    uint256 public proposerBond;
    uint256 public challengerBond;
    uint16  public slashedToChallengerBps;
    uint16  public slashApproverBps;
    uint256 public commitmentBond;

    address public treasury;

    // ── Per-pending-root state ────────────────────────────────────────────────
    struct PendingRoot {
        bytes32 root;
        uint64  proposedAtBlock;
        uint64  snapshotBlock;
        address proposer;
        uint128 proposerBond;
        uint256 approvedStake;       // cumulative bonded stake of approvers
        bool    slashed;
    }
    mapping(uint256 => PendingRoot) private _pending;
    mapping(uint256 => mapping(address => bool)) private _approvedBy;

    // ── Finalized roots (mirrors V1's storage shape) ──────────────────────────
    mapping(uint256 => bytes32) public override rootAt;
    uint256 public override latestEpoch;

    // ── Commitment registry (R1: closes phantom-leaf fraud) ───────────────────
    mapping(bytes32 => bool) public registeredCommitments;
    bytes32[] public commitmentList;

    // ── Pull-pattern payouts ──────────────────────────────────────────────────
    mapping(address => uint256) private _pendingPayout;

    // ── Events ────────────────────────────────────────────────────────────────
    event ReporterJoined(address indexed reporter, uint256 stake);
    event ReporterExitProposed(address indexed reporter, uint64 unlockAtBlock);
    event ReporterExited(address indexed reporter, uint256 amount);
    event ReporterMinStakeSet(uint256 value);
    event ReporterExitDelaySet(uint64 value);
    event ApprovalThresholdBpsSet(uint16 value);
    event ChallengeWindowSet(uint64 value);
    event ProposerBondSet(uint256 value);
    event ChallengerBondSet(uint256 value);
    event SlashedToChallengerBpsSet(uint16 value);
    event SlashApproverBpsSet(uint16 value);
    event CommitmentBondSet(uint256 value);
    event TreasurySet(address treasury);

    event RootProposed(uint256 indexed epoch, bytes32 indexed root, address indexed proposer, uint64 snapshotBlock);
    event RootApproved(uint256 indexed epoch, address indexed approver, uint256 approverStake);
    event RootFinalized(uint256 indexed epoch, bytes32 indexed root);
    event RootSlashed(uint256 indexed epoch, address indexed challenger, uint256 totalSlash);
    event ApproverSlashed(uint256 indexed epoch, address indexed approver, uint256 amount);
    event CommitmentRegistered(bytes32 indexed commitment, address indexed registrant);

    event PayoutClaimed(address indexed recipient, uint256 amount);

    // ── Constructor ───────────────────────────────────────────────────────────
    /// @param _treasury           recipient for the treasury fraction of slashed bonds
    /// @param _reporterMinStake   floor on per-reporter bond (default suggestion: 1 DOT)
    /// @param _reporterExitDelay  blocks between proposeReporterExit and finalizeReporterExit
    /// @param _approvalThresholdBps   fraction of totalReporterStake that must approve (5100 = 51%)
    /// @param _challengeWindow    blocks during which a proposed root can be challenged
    /// @param _proposerBond       bond posted when proposing a root
    /// @param _challengerBond     bond posted to challenge a root
    /// @param _slashedToChallengerBps fraction of slashed total paid to successful challenger
    /// @param _slashApproverBps   fraction of each approver's stake slashed alongside proposer bond
    /// @param _commitmentBond     cost to register a commitment in the on-chain set
    constructor(
        address  _treasury,
        uint256  _reporterMinStake,
        uint64   _reporterExitDelay,
        uint16   _approvalThresholdBps,
        uint64   _challengeWindow,
        uint256  _proposerBond,
        uint256  _challengerBond,
        uint16   _slashedToChallengerBps,
        uint16   _slashApproverBps,
        uint256  _commitmentBond
    ) DatumOwnable() {
        require(_treasury != address(0), "E00");
        require(_reporterMinStake > 0, "E11");
        require(_reporterExitDelay > 0 && _reporterExitDelay <= MAX_REPORTER_EXIT_DELAY, "E11");
        require(_approvalThresholdBps > 0 && _approvalThresholdBps <= MAX_APPROVAL_THRESHOLD_BPS, "E11");
        require(_challengeWindow > 0 && _challengeWindow <= MAX_CHALLENGE_WINDOW, "E11");
        require(_slashedToChallengerBps <= MAX_SLASHED_TO_CHALLENGER_BPS, "E11");
        require(_slashApproverBps <= MAX_SLASH_APPROVER_BPS, "E11");

        treasury = _treasury;
        reporterMinStake = _reporterMinStake;
        reporterExitDelay = _reporterExitDelay;
        approvalThresholdBps = _approvalThresholdBps;
        challengeWindow = _challengeWindow;
        proposerBond = _proposerBond;
        challengerBond = _challengerBond;
        slashedToChallengerBps = _slashedToChallengerBps;
        slashApproverBps = _slashApproverBps;
        commitmentBond = _commitmentBond;
    }

    /// @dev Accept contract-originated transfers (slash residuals).
    receive() external payable {}

    // ── Admin (owner-only) ────────────────────────────────────────────────────
    function setTreasury(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        treasury = addr;
        emit TreasurySet(addr);
    }
    function setReporterMinStake(uint256 v) external onlyOwner {
        require(v > 0, "E11");
        reporterMinStake = v;
        emit ReporterMinStakeSet(v);
    }
    function setReporterExitDelay(uint64 v) external onlyOwner {
        require(v > 0 && v <= MAX_REPORTER_EXIT_DELAY, "E11");
        reporterExitDelay = v;
        emit ReporterExitDelaySet(v);
    }
    function setApprovalThresholdBps(uint16 v) external onlyOwner {
        require(v > 0 && v <= MAX_APPROVAL_THRESHOLD_BPS, "E11");
        approvalThresholdBps = v;
        emit ApprovalThresholdBpsSet(v);
    }
    function setChallengeWindow(uint64 v) external onlyOwner {
        require(v > 0 && v <= MAX_CHALLENGE_WINDOW, "E11");
        challengeWindow = v;
        emit ChallengeWindowSet(v);
    }
    function setProposerBond(uint256 v) external onlyOwner {
        proposerBond = v;
        emit ProposerBondSet(v);
    }
    function setChallengerBond(uint256 v) external onlyOwner {
        challengerBond = v;
        emit ChallengerBondSet(v);
    }
    function setSlashedToChallengerBps(uint16 v) external onlyOwner {
        require(v <= MAX_SLASHED_TO_CHALLENGER_BPS, "E11");
        slashedToChallengerBps = v;
        emit SlashedToChallengerBpsSet(v);
    }
    function setSlashApproverBps(uint16 v) external onlyOwner {
        require(v <= MAX_SLASH_APPROVER_BPS, "E11");
        slashApproverBps = v;
        emit SlashApproverBpsSet(v);
    }
    function setCommitmentBond(uint256 v) external onlyOwner {
        commitmentBond = v;
        emit CommitmentBondSet(v);
    }

    // ── Reporter lifecycle (permissionless) ───────────────────────────────────

    /// @notice Stake-bond to join the permissionless reporter set.
    function joinReporters() external payable nonReentrant {
        require(msg.value >= reporterMinStake, "E11");
        ReporterStake storage s = reporterStake[msg.sender];
        require(s.amount == 0, "E22"); // already a reporter

        s.amount = msg.value;
        s.joinedAtBlock = uint64(block.number);
        _reporterIndex[msg.sender] = reporterList.length;
        reporterList.push(msg.sender);
        totalReporterStake += msg.value;
        emit ReporterJoined(msg.sender, msg.value);
    }

    /// @notice Begin unbonding. Cannot be called twice; cannot propose/approve
    ///         while exit is pending (proposeRoot / approveRoot check
    ///         exitProposedBlock == 0). Removes voting weight immediately so a
    ///         reporter on the way out can't sandwich votes.
    function proposeReporterExit() external {
        ReporterStake storage s = reporterStake[msg.sender];
        require(s.amount > 0, "E01");
        require(s.exitProposedBlock == 0, "E22");
        s.exitProposedBlock = uint64(block.number);
        // Remove voting weight at exit proposal time so we cannot approve
        // future roots from a flagging-down position.
        totalReporterStake -= s.amount;
        emit ReporterExitProposed(msg.sender, s.exitProposedBlock + reporterExitDelay);
    }

    /// @notice Reclaim stake after reporterExitDelay blocks have elapsed.
    function finalizeReporterExit() external nonReentrant {
        ReporterStake storage s = reporterStake[msg.sender];
        require(s.exitProposedBlock != 0, "E01");
        require(block.number >= uint256(s.exitProposedBlock) + uint256(reporterExitDelay), "E96");

        uint256 amount = s.amount;
        // Remove from reporterList via swap-and-pop
        uint256 idx = _reporterIndex[msg.sender];
        uint256 lastIdx = reporterList.length - 1;
        if (idx != lastIdx) {
            address last = reporterList[lastIdx];
            reporterList[idx] = last;
            _reporterIndex[last] = idx;
        }
        reporterList.pop();
        delete _reporterIndex[msg.sender];
        delete reporterStake[msg.sender];

        _pendingPayout[msg.sender] += amount;
        emit ReporterExited(msg.sender, amount);
    }

    function _isActiveReporter(address who) internal view returns (bool) {
        ReporterStake storage s = reporterStake[who];
        return s.amount > 0 && s.exitProposedBlock == 0;
    }

    function reporterCount() external view returns (uint256) { return reporterList.length; }
    function isActiveReporter(address who) external view returns (bool) { return _isActiveReporter(who); }

    // ── Commitment registry (R1) ─────────────────────────────────────────────

    /// @notice Register a Poseidon-commitment in the on-chain set. Required
    ///         before any leaf with this commitment can be included in a
    ///         finalized root (enforced via challengePhantomLeaf). Bond is
    ///         non-refundable — pricing the per-commitment Sybil cost.
    function registerCommitment(bytes32 commitment) external payable nonReentrant {
        require(msg.value >= commitmentBond, "E11");
        require(commitment != bytes32(0), "E00");
        require(!registeredCommitments[commitment], "E22");

        registeredCommitments[commitment] = true;
        commitmentList.push(commitment);
        // Bond is routed to treasury (Sybil-pricing, not refundable).
        if (msg.value > 0) _pendingPayout[treasury] += msg.value;

        emit CommitmentRegistered(commitment, msg.sender);
    }

    function commitmentCount() external view returns (uint256) { return commitmentList.length; }

    // ── Root proposal / approval / finalization ──────────────────────────────

    /// @notice Propose a new stake root. Caller must be an active reporter
    ///         (stake ≥ min, not in exit) and post proposerBond.
    /// @param epoch         must be strictly greater than latestEpoch
    /// @param snapshotBlock block at which the off-chain tree was computed.
    ///                      Future fraud-proof modes will read DATUM token state
    ///                      against this block. Must not be a future block.
    /// @param root          Merkle root of leaves (Poseidon(commitment, balance))
    function proposeRoot(uint256 epoch, uint64 snapshotBlock, bytes32 root) external payable nonReentrant {
        require(_isActiveReporter(msg.sender), "E01");
        require(msg.value >= proposerBond, "E11");
        require(epoch > latestEpoch, "E64");
        require(root != bytes32(0), "E11");
        require(snapshotBlock <= block.number, "E11");
        require(_pending[epoch].proposer == address(0), "E22"); // first-finalised-wins
        require(rootAt[epoch] == bytes32(0), "E22");

        PendingRoot storage p = _pending[epoch];
        p.root = root;
        p.proposedAtBlock = uint64(block.number);
        p.snapshotBlock = snapshotBlock;
        p.proposer = msg.sender;
        p.proposerBond = uint128(msg.value);

        // Proposer's own stake counts as the first approval.
        _approvedBy[epoch][msg.sender] = true;
        p.approvedStake = reporterStake[msg.sender].amount;

        emit RootProposed(epoch, root, msg.sender, snapshotBlock);
        emit RootApproved(epoch, msg.sender, reporterStake[msg.sender].amount);
    }

    /// @notice Co-sign a pending root. Adds the caller's bonded stake to the
    ///         approval tally. Cannot approve after the challenge window closes
    ///         (no point — finalization is one-shot).
    function approveRoot(uint256 epoch) external nonReentrant {
        require(_isActiveReporter(msg.sender), "E01");
        PendingRoot storage p = _pending[epoch];
        require(p.proposer != address(0), "E01");
        require(!p.slashed, "E22");
        require(block.number <= uint256(p.proposedAtBlock) + uint256(challengeWindow), "E96");
        require(!_approvedBy[epoch][msg.sender], "E22");

        _approvedBy[epoch][msg.sender] = true;
        p.approvedStake += reporterStake[msg.sender].amount;
        emit RootApproved(epoch, msg.sender, reporterStake[msg.sender].amount);
    }

    /// @notice Finalize a pending root after the challenge window closes.
    ///         Requires approvedStake ≥ approvalThresholdBps × totalReporterStake.
    function finalizeRoot(uint256 epoch) external nonReentrant {
        PendingRoot storage p = _pending[epoch];
        require(p.proposer != address(0), "E01");
        require(!p.slashed, "E22");
        require(block.number > uint256(p.proposedAtBlock) + uint256(challengeWindow), "E96");
        require(p.approvedStake * 10000 >= totalReporterStake * uint256(approvalThresholdBps), "E46");

        bytes32 root = p.root;
        rootAt[epoch] = root;
        if (epoch > latestEpoch) latestEpoch = epoch;

        // Refund proposer bond
        _pendingPayout[p.proposer] += uint256(p.proposerBond);

        // Clear pending state. We don't iterate _approvedBy[epoch][*] — that
        // mapping persists, which is fine (it's never re-read after finalization
        // and storage refunds aren't worth the complexity).
        delete _pending[epoch];

        emit RootFinalized(epoch, root);
    }

    // ── Fraud proofs ─────────────────────────────────────────────────────────

    /// @notice Phantom-leaf challenge: anyone can prove a leaf is in the
    ///         proposed root but its commitment is NOT in the on-chain
    ///         registered set. Slashes the proposer (and approvers).
    ///
    /// @param epoch          target pending root
    /// @param commitment     the commitment encoded in the bad leaf
    /// @param claimedBalance the balance encoded in the bad leaf
    /// @param leafIndex      index of the leaf in the Merkle tree
    /// @param siblings       Merkle path siblings from leaf to root
    /// @dev Leaf is computed as keccak256(commitment, claimedBalance). Real
    ///      deployment will likely use Poseidon for circuit compatibility;
    ///      keccak is used here for cheaper on-chain verification and is
    ///      consistent with how the challenger constructs the leaf. The
    ///      reporters' off-chain tree builder must match this.
    function challengePhantomLeaf(
        uint256 epoch,
        bytes32 commitment,
        uint256 claimedBalance,
        uint256 leafIndex,
        bytes32[] calldata siblings
    ) external payable nonReentrant {
        require(msg.value >= challengerBond, "E11");
        PendingRoot storage p = _pending[epoch];
        require(p.proposer != address(0), "E01");
        require(!p.slashed, "E22");
        require(block.number <= uint256(p.proposedAtBlock) + uint256(challengeWindow), "E96");

        // 1. Verify the leaf is actually in the proposed root
        bytes32 leaf = keccak256(abi.encodePacked(commitment, claimedBalance));
        require(_verifyMerkle(p.root, leaf, leafIndex, siblings), "E53");

        // 2. Verify the commitment is NOT registered (phantom)
        require(!registeredCommitments[commitment], "E53");

        // Refund challenger their bond before slashing accounting
        _pendingPayout[msg.sender] += msg.value;

        _slashProposer(epoch, msg.sender);
    }

    function _verifyMerkle(
        bytes32 root,
        bytes32 leaf,
        uint256 index,
        bytes32[] calldata siblings
    ) internal pure returns (bool) {
        bytes32 hash = leaf;
        uint256 idx = index;
        for (uint256 i = 0; i < siblings.length; i++) {
            bytes32 sib = siblings[i];
            if (idx & 1 == 0) {
                hash = keccak256(abi.encodePacked(hash, sib));
            } else {
                hash = keccak256(abi.encodePacked(sib, hash));
            }
            idx >>= 1;
        }
        return hash == root;
    }

    function _slashProposer(uint256 epoch, address challenger) internal {
        PendingRoot storage p = _pending[epoch];
        p.slashed = true;

        uint256 totalSlash = uint256(p.proposerBond);
        // Also slash slashApproverBps% of every approver's bonded stake
        for (uint256 i = 0; i < reporterList.length; i++) {
            address r = reporterList[i];
            if (_approvedBy[epoch][r] && r != p.proposer) {
                uint256 cut = reporterStake[r].amount * uint256(slashApproverBps) / 10000;
                if (cut > 0) {
                    reporterStake[r].amount -= cut;
                    totalReporterStake -= cut;
                    totalSlash += cut;
                    emit ApproverSlashed(epoch, r, cut);
                }
            }
        }
        // Proposer's own stake is also slashed at the approver rate (proposer
        // is the most-culpable approver of their own bad root)
        if (_approvedBy[epoch][p.proposer]) {
            uint256 cut = reporterStake[p.proposer].amount * uint256(slashApproverBps) / 10000;
            if (cut > 0) {
                reporterStake[p.proposer].amount -= cut;
                totalReporterStake -= cut;
                totalSlash += cut;
                emit ApproverSlashed(epoch, p.proposer, cut);
            }
        }

        uint256 toChallenger = totalSlash * uint256(slashedToChallengerBps) / 10000;
        uint256 toTreasury = totalSlash - toChallenger;
        if (toChallenger > 0) _pendingPayout[challenger] += toChallenger;
        if (toTreasury > 0) _pendingPayout[treasury] += toTreasury;

        emit RootSlashed(epoch, challenger, totalSlash);
    }

    // ── Pull-pattern claim ───────────────────────────────────────────────────
    function claim() external nonReentrant {
        _claim(msg.sender, msg.sender);
    }
    function claimTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claim(msg.sender, recipient);
    }
    function _claim(address account, address recipient) internal {
        uint256 amount = _pendingPayout[account];
        require(amount > 0, "E03");
        _pendingPayout[account] = 0;
        emit PayoutClaimed(recipient, amount);
        _safeSend(recipient, amount);
    }
    function pending(address account) external view returns (uint256) {
        return _pendingPayout[account];
    }

    // ── IDatumStakeRoot view: isRecent ───────────────────────────────────────
    function isRecent(bytes32 root) external view override returns (bool) {
        if (root == bytes32(0)) return false;
        uint256 start = latestEpoch < LOOKBACK_EPOCHS ? 0 : latestEpoch - LOOKBACK_EPOCHS + 1;
        for (uint256 e = start; e <= latestEpoch; e++) {
            if (rootAt[e] == root) return true;
        }
        return false;
    }

    // ── Pending-root views (debug + UI) ──────────────────────────────────────
    function pendingRoot(uint256 epoch) external view returns (
        bytes32 root,
        uint64  proposedAtBlock,
        uint64  snapshotBlock,
        address proposer,
        uint128 proposerBond_,
        uint256 approvedStake,
        bool    slashed
    ) {
        PendingRoot storage p = _pending[epoch];
        return (p.root, p.proposedAtBlock, p.snapshotBlock, p.proposer,
                p.proposerBond, p.approvedStake, p.slashed);
    }
    function hasApproved(uint256 epoch, address who) external view returns (bool) {
        return _approvedBy[epoch][who];
    }
}
