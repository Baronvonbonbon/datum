// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";

/// @dev Minimal write-side view of DatumPeopleChainIdentity. The bonded
///      reporter contract becomes one of the cache's authorized writers
///      (alongside `oracleReporter` for Diana fallback and `xcmDispatcher`
///      for the bridge). Wiring happens at deploy time; this interface
///      pins only the call shape.
interface IPeopleChainIdentityWriteFromReporter {
    function submitAttestation(address user, uint8 level, uint64 validityBlocks) external;
}

/// @title  DatumBondedIdentityReporter
/// @notice Permissionless bonded multi-reporter set for People Chain
///         identity attestations. Mirrors `DatumStakeRootV2`:
///           - anyone with ≥ reporterMinStake PAS can join
///           - any active reporter can submit an attestation (with bond)
///           - other reporters can approve to fast-finalize when the
///             approval-stake threshold is met
///           - anyone can challenge an attestation (with bond); resolution
///             is governance-arbitrated (Option γ) in v1
///           - after the challenge window, any caller can finalize an
///             un-challenged attestation, which writes through to the
///             cache via submitAttestation
///
///         **Design doc:** `narrative-analysis/bonded-reporter-identity.md`.
///         **Status:** v1 — challenge resolution is owner-arbitrated. The
///         design doc Section 3a covers the eventual move to Option α
///         (registrar-signature verification) once we know how to anchor
///         the People Chain registrar set on Hub.
///
/// @dev    The cache (`DatumPeopleChainIdentity`) must authorize this
///         contract as a writer. Deploy choices:
///           (a) Add a `bondedReporter` slot to the cache (additive).
///           (b) Repurpose the cache's `xcmDispatcher` slot to point
///               here, and have the bridge submit through this contract
///               instead of writing the cache directly.
///         We document (a) as the cleaner path in the runbook.
contract DatumBondedIdentityReporter is DatumUpgradable, PaseoSafeSender {

    /// @notice Upgrade ladder version. Increment per deployment when storage
    ///         layout or behavior changes.
    function version() public pure override returns (uint256) { return 1; }

    // ── Constants (sanity ceilings — params governable up to these) ───────────
    uint256 public constant MAX_APPROVAL_THRESHOLD_BPS = 9900;
    uint64  public constant MAX_CHALLENGE_WINDOW       = 1_209_600;  // ~84d
    uint64  public constant MAX_REPORTER_EXIT_DELAY    = 1_209_600;
    uint16  public constant MAX_SLASHED_TO_CHALLENGER_BPS = 10000;
    uint16  public constant MAX_SLASH_APPROVER_BPS     = 5000;       // 50% cap
    uint64  public constant MIN_VALIDITY_BLOCKS        = 600;        // ~1h
    uint64  public constant MAX_VALIDITY_BLOCKS        = 1_440_000;  // ~100d

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

    // ── Identity cache (lock-once) ────────────────────────────────────────────
    IPeopleChainIdentityWriteFromReporter public cache;
    bool public cacheLocked;

    // ── Governable parameters ─────────────────────────────────────────────────
    uint256 public reporterMinStake;
    uint64  public reporterExitDelay;
    uint16  public approvalThresholdBps;
    uint64  public challengeWindow;
    uint256 public proposerBond;
    uint256 public challengerBond;
    uint16  public slashedToChallengerBps;
    uint16  public slashApproverBps;

    address public treasury;

    // ── Attestation state ─────────────────────────────────────────────────────
    /// @dev Attestation key = `keccak256(proposer, user, nonce)`. Nonce is
    ///      auto-incremented per proposer to allow many in-flight
    ///      attestations from the same reporter for the same user.
    enum AttestStatus {
        None,        // never submitted
        Pending,     // in challenge window
        Challenged,  // disputed; awaiting owner resolution
        Finalized,   // written to cache (terminal)
        Slashed      // proposer bond + approvers slashed (terminal)
    }

    struct Attestation {
        address proposer;
        address user;
        uint8   level;
        uint64  validityBlocks;
        uint64  proposedAtBlock;
        uint128 proposerBondPaid;
        uint256 approvedStake;       // cumulative bonded stake of approvers
        address challenger;          // 0 if not challenged
        uint128 challengerBondPaid;
        AttestStatus status;
    }
    mapping(bytes32 => Attestation) public attestations;
    /// @dev approver tracking per attestation key
    mapping(bytes32 => mapping(address => bool)) private _approvedBy;
    /// @dev approver list per attestation key (for slash iteration)
    mapping(bytes32 => address[]) private _approverList;
    /// @dev per-proposer nonce so multiple in-flight attestations don't collide
    mapping(address => uint64) public proposerNonce;

    // ── Pull-pattern payouts ──────────────────────────────────────────────────
    mapping(address => uint256) private _pendingPayout;

    // ── Events ────────────────────────────────────────────────────────────────
    event CacheSet(address indexed cache);
    event CacheLocked();
    event ReporterJoined(address indexed reporter, uint256 stake);
    event ReporterExitProposed(address indexed reporter, uint64 unlockAtBlock);
    event ReporterExited(address indexed reporter, uint256 amount);
    event TreasurySet(address treasury);
    event ReporterMinStakeSet(uint256 value);
    event ReporterExitDelaySet(uint64 value);
    event ApprovalThresholdBpsSet(uint16 value);
    event ChallengeWindowSet(uint64 value);
    event ProposerBondSet(uint256 value);
    event ChallengerBondSet(uint256 value);
    event SlashedToChallengerBpsSet(uint16 value);
    event SlashApproverBpsSet(uint16 value);

    event AttestationSubmitted(
        bytes32 indexed key,
        address indexed proposer,
        address indexed user,
        uint8   level,
        uint64  validityBlocks,
        uint64  unlockAtBlock
    );
    event AttestationApproved(bytes32 indexed key, address indexed approver, uint256 approverStake);
    event AttestationChallenged(bytes32 indexed key, address indexed challenger);
    event AttestationFinalized(bytes32 indexed key);
    event AttestationSlashed(bytes32 indexed key, address indexed challenger, uint256 totalSlash);
    event ApproverSlashed(bytes32 indexed key, address indexed approver, uint256 amount);
    event ChallengeDismissed(bytes32 indexed key);
    event PayoutClaimed(address indexed recipient, uint256 amount);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address _treasury,
        uint256 _reporterMinStake,
        uint64  _reporterExitDelay,
        uint16  _approvalThresholdBps,
        uint64  _challengeWindow,
        uint256 _proposerBond,
        uint256 _challengerBond,
        uint16  _slashedToChallengerBps,
        uint16  _slashApproverBps
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
    }

    /// @dev Accept contract-originated transfers (slash residuals, refunds).
    receive() external payable {}

    // ── Admin (owner-only) ────────────────────────────────────────────────────
    /// @notice Lock-once cache wiring. Required before any attestation can
    ///         finalize (finalize calls into the cache).
    function setCache(address addr) external onlyOwner {
        require(!cacheLocked, "cache-locked");
        require(addr != address(0), "E00");
        cache = IPeopleChainIdentityWriteFromReporter(addr);
        emit CacheSet(addr);
    }
    function lockCache() external onlyOwner whenOpenGovPhase {
        require(address(cache) != address(0), "E00");
        cacheLocked = true;
        emit CacheLocked();
    }

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

    // ── Reporter lifecycle ────────────────────────────────────────────────────
    /// @notice Stake-bond to join the permissionless reporter set.
    function joinReporters() external payable nonReentrant whenNotFrozen {
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

    /// @notice Begin unbonding. Decrements totalReporterStake immediately
    ///         so an exit-proposed reporter cannot influence further
    ///         approvals.
    function proposeReporterExit() external whenNotFrozen {
        ReporterStake storage s = reporterStake[msg.sender];
        require(s.amount > 0, "E01");
        require(s.exitProposedBlock == 0, "E22");
        s.exitProposedBlock = uint64(block.number);
        totalReporterStake -= s.amount;
        emit ReporterExitProposed(msg.sender, s.exitProposedBlock + reporterExitDelay);
    }

    /// @notice Reclaim stake after reporterExitDelay blocks have elapsed.
    function finalizeReporterExit() external nonReentrant whenNotFrozen {
        ReporterStake storage s = reporterStake[msg.sender];
        require(s.exitProposedBlock != 0, "E01");
        require(block.number >= uint256(s.exitProposedBlock) + uint256(reporterExitDelay), "E96");

        uint256 amount = s.amount;
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
    function isActiveReporter(address who) external view returns (bool) { return _isActiveReporter(who); }
    function reporterCount() external view returns (uint256) { return reporterList.length; }

    // ── Attestation flow ──────────────────────────────────────────────────────

    /// @notice Submit an identity attestation. Caller must be an active
    ///         reporter and post proposerBond. Returns the attestation key.
    /// @dev    The key is deterministic in (proposer, user, nonce) so
    ///         clients can mirror it off-chain. Approval / challenge /
    ///         finalize all reference this key.
    function submitAttestation(
        address user,
        uint8   level,
        uint64  validityBlocks
    ) external payable nonReentrant whenNotFrozen returns (bytes32 key) {
        require(_isActiveReporter(msg.sender), "E01");
        require(msg.value >= proposerBond, "E11");
        require(user != address(0), "E00");
        require(level <= 2, "E11");
        require(validityBlocks >= MIN_VALIDITY_BLOCKS && validityBlocks <= MAX_VALIDITY_BLOCKS, "E11");

        uint64 n = proposerNonce[msg.sender]++;
        key = keccak256(abi.encode(msg.sender, user, n));

        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.None, "E22");
        a.proposer        = msg.sender;
        a.user            = user;
        a.level           = level;
        a.validityBlocks  = validityBlocks;
        a.proposedAtBlock = uint64(block.number);
        a.proposerBondPaid = uint128(msg.value);
        a.status          = AttestStatus.Pending;

        emit AttestationSubmitted(
            key, msg.sender, user, level, validityBlocks,
            uint64(block.number) + challengeWindow
        );
    }

    /// @notice Approve a pending attestation. Adds the approver's bonded
    ///         stake to the attestation's approval tally. When tally
    ///         reaches `approvalThresholdBps` of total reporter stake,
    ///         the attestation can be finalized without waiting for the
    ///         challenge window.
    function approveAttestation(bytes32 key) external whenNotFrozen {
        require(_isActiveReporter(msg.sender), "E01");
        require(!_approvedBy[key][msg.sender], "E22");
        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.Pending, "E22");
        require(a.proposer != msg.sender, "E18"); // proposer can't self-approve

        _approvedBy[key][msg.sender] = true;
        _approverList[key].push(msg.sender);
        a.approvedStake += reporterStake[msg.sender].amount;
        emit AttestationApproved(key, msg.sender, reporterStake[msg.sender].amount);
    }

    /// @notice Challenge a pending attestation with a bond. The
    ///         attestation enters Challenged status and cannot finalize
    ///         until the owner (Timelock) resolves it via slashAttestation
    ///         or dismissChallenge. v1 is owner-arbitrated; v2 will
    ///         accept registrar-signature counter-evidence per design doc §3a.
    function challengeAttestation(bytes32 key) external payable nonReentrant whenNotFrozen {
        require(msg.value >= challengerBond, "E11");
        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.Pending, "E22");
        require(block.number < uint256(a.proposedAtBlock) + uint256(challengeWindow), "E96");
        require(msg.sender != a.proposer, "E18");

        a.status = AttestStatus.Challenged;
        a.challenger = msg.sender;
        a.challengerBondPaid = uint128(msg.value);
        emit AttestationChallenged(key, msg.sender);
    }

    /// @notice Owner-arbitrated slash. Marks attestation as Slashed,
    ///         routes proposer + approver bonds + slashApproverBps of
    ///         approver stake to the challenger + treasury split.
    /// @dev    v1: owner is the Timelock; resolution requires a passed
    ///         proposal with 48h delay. v2 will replace with on-chain
    ///         counter-evidence verification.
    function slashAttestation(bytes32 key) external onlyOwner nonReentrant whenNotFrozen {
        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.Challenged, "E22");

        uint256 proposerPart = uint256(a.proposerBondPaid);
        uint256 approverSlashTotal = 0;

        // Slash each approver
        address[] memory approvers = _approverList[key];
        for (uint256 i = 0; i < approvers.length; i++) {
            address app = approvers[i];
            ReporterStake storage rs = reporterStake[app];
            uint256 slashAmt = (rs.amount * slashApproverBps) / 10000;
            if (slashAmt > rs.amount) slashAmt = rs.amount;
            if (slashAmt > 0) {
                rs.amount -= slashAmt;
                // Only adjust totalReporterStake if approver hasn't already
                // exit-proposed (H3 fix mirrors StakeRootV2).
                if (rs.exitProposedBlock == 0) {
                    totalReporterStake -= slashAmt;
                }
                approverSlashTotal += slashAmt;
                emit ApproverSlashed(key, app, slashAmt);
            }
        }

        // Slash proposer's bond AND proportional stake
        uint256 propStakeSlash = (reporterStake[a.proposer].amount * slashApproverBps) / 10000;
        ReporterStake storage prs = reporterStake[a.proposer];
        if (propStakeSlash > prs.amount) propStakeSlash = prs.amount;
        if (propStakeSlash > 0) {
            prs.amount -= propStakeSlash;
            if (prs.exitProposedBlock == 0) {
                totalReporterStake -= propStakeSlash;
            }
        }

        uint256 totalSlash = proposerPart + approverSlashTotal + propStakeSlash;
        uint256 toChallenger = (totalSlash * slashedToChallengerBps) / 10000;
        uint256 toTreasury   = totalSlash - toChallenger;

        // Challenger gets their bond back plus the challenger share
        _pendingPayout[a.challenger] += uint256(a.challengerBondPaid) + toChallenger;
        _pendingPayout[treasury]     += toTreasury;

        a.status = AttestStatus.Slashed;
        emit AttestationSlashed(key, a.challenger, totalSlash);
    }

    /// @notice Owner-arbitrated dismiss. Marks attestation back as
    ///         Pending (so it can still finalize after the window), and
    ///         routes the challenger's bond to the treasury (anti-grief).
    /// @dev    Resets challenge fields so a fresh challenge could in
    ///         theory fire if challengeWindow hasn't elapsed; in
    ///         practice the dismissal usually happens after the window,
    ///         making the attestation immediately finalizable.
    function dismissChallenge(bytes32 key) external onlyOwner nonReentrant whenNotFrozen {
        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.Challenged, "E22");

        uint256 forfeited = uint256(a.challengerBondPaid);
        a.challenger = address(0);
        a.challengerBondPaid = 0;
        a.status = AttestStatus.Pending;

        _pendingPayout[treasury] += forfeited;
        emit ChallengeDismissed(key);
    }

    /// @notice Finalize a pending attestation. Two paths:
    ///         - Fast path: approval-threshold met → finalize immediately
    ///         - Slow path: challengeWindow elapsed without challenge
    ///         Either way, writes through to the cache and refunds the
    ///         proposer's bond.
    function finalizeAttestation(bytes32 key) external nonReentrant whenNotFrozen {
        require(address(cache) != address(0), "cache-unset");
        Attestation storage a = attestations[key];
        require(a.status == AttestStatus.Pending, "E22");

        bool threshold = totalReporterStake > 0
            && (a.approvedStake * 10000 >= totalReporterStake * approvalThresholdBps);
        bool windowDone = block.number >= uint256(a.proposedAtBlock) + uint256(challengeWindow);
        require(threshold || windowDone, "E96");

        a.status = AttestStatus.Finalized;
        // Refund proposer bond. Pull-pattern so a reverting recipient
        // can't block finalization.
        _pendingPayout[a.proposer] += uint256(a.proposerBondPaid);

        cache.submitAttestation(a.user, a.level, a.validityBlocks);
        emit AttestationFinalized(key);
    }

    // ── Pull-payment claim ────────────────────────────────────────────────────
    function pending(address account) external view returns (uint256) {
        return _pendingPayout[account];
    }

    function claim() external nonReentrant {
        _claim(msg.sender, payable(msg.sender));
    }

    function claimTo(address payable recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claim(msg.sender, recipient);
    }

    function _claim(address account, address payable recipient) internal {
        uint256 amount = _pendingPayout[account];
        require(amount > 0, "E03");
        _pendingPayout[account] = 0;
        _safeSend(recipient, amount);
        emit PayoutClaimed(recipient, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────
    function attestationKey(address proposer, address user, uint64 nonce)
        external pure returns (bytes32)
    {
        return keccak256(abi.encode(proposer, user, nonce));
    }

    function attestationApprovers(bytes32 key) external view returns (address[] memory) {
        return _approverList[key];
    }

    function isApproved(bytes32 key, address by) external view returns (bool) {
        return _approvedBy[key][by];
    }
}
