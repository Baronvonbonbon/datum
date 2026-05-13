// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";

/// @title DatumPauseRegistry
/// @notice Global emergency pause circuit breaker.
///
///         A5 model (cypherpunk-aligned):
///           - **Fast pause:** any single guardian (1-of-N) OR owner-while-bootstrap
///             can pause the system instantly. Designed for live-exploit response —
///             no coordination required when funds are draining.
///           - **Slow unpause:** requires 2-of-3 guardian approval. Asymmetry is by
///             design — restoring the system must take more witnesses than tripping it.
///           - **Guardian rotation:** sitting guardians vote 2-of-3 to replace the
///             set. The owner-only `setGuardians` is preserved for the initial
///             bootstrap (since the deployer is necessarily the only authority on
///             day 0) but can be permanently disabled via `lockGuardianSet()`,
///             after which only the guardians themselves can change the set.
///
///         All DATUM contracts check `paused()` via staticcall before critical
///         operations. The 2-of-3 mechanism for unpause and rotation lives inside
///         the same Proposal type, distinguished by `action`.
///
///         Replay protection: each proposal is marked `executed` rather than
///         deleted (AUDIT-021), and approvers are tracked per-proposal.
contract DatumPauseRegistry is DatumOwnable {
    /// @dev CB6: per-category pause bitfield. `paused()` returns true iff any
    ///      active category remains within its MAX_PAUSE_BLOCKS expiry window.
    uint8 internal _pausedCategoriesRaw;
    /// @notice CB6: per-category engagement block, for independent expiry.
    mapping(uint8 => uint256) public pausedAtBlockFor;

    /// @notice CB6: category bit values. Powers of 2 so they can be OR'd into
    ///         the bitfield. CAT_ALL = full-stop pause.
    uint8 public constant CAT_SETTLEMENT        = 1 << 0;
    uint8 public constant CAT_CAMPAIGN_CREATION = 1 << 1;
    uint8 public constant CAT_GOVERNANCE        = 1 << 2;
    uint8 public constant CAT_TOKEN_MINT        = 1 << 3;
    uint8 public constant CAT_ALL = CAT_SETTLEMENT | CAT_CAMPAIGN_CREATION | CAT_GOVERNANCE | CAT_TOKEN_MINT;

    /// @notice Convenience accessor: block number of the most-recent pause
    ///         engagement across any category. Observers should prefer
    ///         pausedAtBlockFor[category] for precise per-category timing.
    uint256 public pausedAtBlock;

    /// @notice A6/B6-fix (2026-05-12): pause auto-expiry. ~14 days at 6s/block
    ///         (14400 blocks/day × 14). After this window, `paused()` returns
    ///         false even if `_pausedRaw == true`. Guardians can still re-engage
    ///         via pauseFast() — this just caps the unbroken pause duration so
    ///         no single guardian can freeze the system forever.
    uint256 public constant MAX_PAUSE_BLOCKS = 201600;

    // SM-6: guardian set
    address[3] public guardians;
    uint256 private _proposalNonce;

    /// @notice A5: once locked, only sitting guardians (2-of-3) can rotate the
    ///         guardian set. The owner loses unilateral authority over the
    ///         protocol's safety committee. Designed to be flipped permanently
    ///         after the genuine guardian set is in place.
    bool public guardianSetLocked;

    // ---- Proposal types ----
    // action 2 (unpause-all), 3 (rotate guardians),
    // action 4 (CB6: unpause specific categories)
    struct Proposal {
        uint8 action;
        address proposer;
        uint8 approvals;
        bool executed;
        // Used when action == 3 (rotate guardians)
        address ng0;
        address ng1;
        address ng2;
        // CB6: used when action == 4 (categorical unpause)
        uint8 categories;
        mapping(address => bool) voted;
    }
    mapping(uint256 => Proposal) private _proposals;

    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event PausedCategory(address indexed by, uint8 indexed categories);
    event UnpausedCategory(address indexed by, uint8 indexed categories);
    event GuardiansUpdated(address g0, address g1, address g2);
    event GuardianSetLocked();
    event PauseProposed(uint256 indexed proposalId, uint8 action, address indexed proposer);
    event PauseApproved(uint256 indexed proposalId, address indexed approver);
    event GuardianRotationProposed(uint256 indexed proposalId, address indexed proposer, address ng0, address ng1, address ng2);

    constructor(address g0, address g1, address g2) {
        _setGuardians(g0, g1, g2);
    }

    // -------------------------------------------------------------------------
    // Bootstrap admin — owner authority, frozen after `lockGuardianSet`
    // -------------------------------------------------------------------------

    /// @notice Bootstrap-only guardian set rotation. After `lockGuardianSet()`
    ///         this reverts; rotation must go through the 2-of-3 guardian flow.
    function setGuardians(address g0, address g1, address g2) external onlyOwner {
        require(!guardianSetLocked, "locked");
        _setGuardians(g0, g1, g2);
    }

    /// @notice A5: permanently disable owner authority over the guardian set.
    ///         Irreversible. After this the owner can still call no other
    ///         pause-related function — guardians become fully self-managing.
    function lockGuardianSet() external onlyOwner {
        require(!guardianSetLocked, "already locked");
        guardianSetLocked = true;
        emit GuardianSetLocked();
    }

    function _setGuardians(address g0, address g1, address g2) internal {
        require(g0 != address(0) && g1 != address(0) && g2 != address(0), "E00");
        require(g0 != g1 && g1 != g2 && g0 != g2, "E11");
        guardians[0] = g0;
        guardians[1] = g1;
        guardians[2] = g2;
        emit GuardiansUpdated(g0, g1, g2);
    }

    // -------------------------------------------------------------------------
    // A5: solo fast-pause (any guardian)
    // -------------------------------------------------------------------------

    function _isGuardian(address addr) internal view returns (bool) {
        return addr == guardians[0] || addr == guardians[1] || addr == guardians[2];
    }

    /// @notice Any guardian can pause the system unilaterally. The asymmetry
    ///         vs. unpause is deliberate — live exploits don't wait for quorum.
    function pauseFast() external {
        require(_isGuardian(msg.sender), "E18");
        _engage(msg.sender, CAT_ALL);
    }

    /// @notice CB6: per-category fast-pause. Any guardian can pause a subset
    ///         of categories, limiting blast radius. `categories` is a
    ///         bitfield of CAT_* constants.
    function pauseFastCategories(uint8 categories) external {
        require(_isGuardian(msg.sender), "E18");
        require(categories != 0 && (categories & ~CAT_ALL) == 0, "E11");
        _engage(msg.sender, categories);
    }

    /// @notice Owner solo pause — kept for emergency response by the deploying
    ///         party. Engages every category. Unpause still requires guardian
    ///         quorum, so even an attacker who steals the owner key can only
    ///         ratchet the system into pause; recovery remains gated on the
    ///         (potentially rotated) guardians.
    function pause() external onlyOwner {
        _engage(msg.sender, CAT_ALL);
    }

    /// @dev Internal helper: OR `categories` into the bitfield and refresh the
    ///      engagement block for each. Idempotent — re-engaging an already-
    ///      active category resets its expiry clock (useful: a guardian can
    ///      extend a near-expired pause by re-calling pauseFast).
    function _engage(address by, uint8 categories) internal {
        require(categories != 0, "E11");
        _pausedCategoriesRaw |= categories;
        if (categories & CAT_SETTLEMENT        != 0) pausedAtBlockFor[CAT_SETTLEMENT]        = block.number;
        if (categories & CAT_CAMPAIGN_CREATION != 0) pausedAtBlockFor[CAT_CAMPAIGN_CREATION] = block.number;
        if (categories & CAT_GOVERNANCE        != 0) pausedAtBlockFor[CAT_GOVERNANCE]        = block.number;
        if (categories & CAT_TOKEN_MINT        != 0) pausedAtBlockFor[CAT_TOKEN_MINT]        = block.number;
        pausedAtBlock = block.number;
        emit PausedCategory(by, categories);
        emit Paused(by);
    }

    /// @notice CB6: bitfield of currently-active (within-window) categories.
    function _activeMask() internal view returns (uint8 mask) {
        uint8 raw = _pausedCategoriesRaw;
        if (raw == 0) return 0;
        if (raw & CAT_SETTLEMENT        != 0 && block.number <= pausedAtBlockFor[CAT_SETTLEMENT]        + MAX_PAUSE_BLOCKS) mask |= CAT_SETTLEMENT;
        if (raw & CAT_CAMPAIGN_CREATION != 0 && block.number <= pausedAtBlockFor[CAT_CAMPAIGN_CREATION] + MAX_PAUSE_BLOCKS) mask |= CAT_CAMPAIGN_CREATION;
        if (raw & CAT_GOVERNANCE        != 0 && block.number <= pausedAtBlockFor[CAT_GOVERNANCE]        + MAX_PAUSE_BLOCKS) mask |= CAT_GOVERNANCE;
        if (raw & CAT_TOKEN_MINT        != 0 && block.number <= pausedAtBlockFor[CAT_TOKEN_MINT]        + MAX_PAUSE_BLOCKS) mask |= CAT_TOKEN_MINT;
    }

    /// @notice True iff ANY category is currently paused. CB6-aware call
    ///         sites should prefer the per-category accessors below for
    ///         more precise gating.
    function paused() public view returns (bool) {
        return _activeMask() != 0;
    }

    /// @notice CB6: per-category pause checks. Each contract should call the
    ///         category most relevant to its operation — a settlement pause
    ///         should not block governance from responding.
    function pausedSettlement()       external view returns (bool) { return (_activeMask() & CAT_SETTLEMENT)        != 0; }
    function pausedCampaignCreation() external view returns (bool) { return (_activeMask() & CAT_CAMPAIGN_CREATION) != 0; }
    function pausedGovernance()       external view returns (bool) { return (_activeMask() & CAT_GOVERNANCE)        != 0; }
    function pausedTokenMint()        external view returns (bool) { return (_activeMask() & CAT_TOKEN_MINT)         != 0; }

    /// @notice CB6: raw bitfield read for observers that want the full state.
    function pausedCategories() external view returns (uint8) { return _activeMask(); }

    // -------------------------------------------------------------------------
    // SM-6: 2-of-3 guardian unpause (action == 2)
    // -------------------------------------------------------------------------

    /// @notice Propose an unpause (action=2). Pause is intentionally not a
    ///         valid action here — use `pauseFast` instead.
    function propose(uint8 action) external returns (uint256 proposalId) {
        require(_isGuardian(msg.sender), "E18");
        require(action == 2, "E11");
        require(paused(), "E11"); // must currently be paused to propose unpause

        proposalId = ++_proposalNonce;
        Proposal storage p = _proposals[proposalId];
        p.action = action;
        p.proposer = msg.sender;
        p.approvals = 1;
        p.voted[msg.sender] = true;
        emit PauseProposed(proposalId, action, msg.sender);
    }

    /// @notice Approve an existing proposal. Executes on the 2nd vote.
    function approve(uint256 proposalId) external {
        require(_isGuardian(msg.sender), "E18");
        Proposal storage p = _proposals[proposalId];
        require(p.action != 0, "E01");
        require(!p.executed, "E11");
        require(!p.voted[msg.sender], "E11");

        // Pre-execution state validation per action type.
        if (p.action == 2) {
            require(paused(), "E11");
        } else if (p.action == 4) {
            // CB6: must still have at least one of the target categories active.
            require((_activeMask() & p.categories) != 0, "E11");
        }
        // action == 3 (guardian rotation) needs no pre-state guard.

        p.voted[msg.sender] = true;
        p.approvals++;
        emit PauseApproved(proposalId, msg.sender);

        if (p.approvals >= 2) {
            p.executed = true;
            _execute(p);
        }
    }

    function _execute(Proposal storage p) internal {
        if (p.action == 2) {
            // Unpause all categories.
            uint8 cleared = _pausedCategoriesRaw;
            _pausedCategoriesRaw = 0;
            pausedAtBlock = 0;
            emit UnpausedCategory(msg.sender, cleared);
            emit Unpaused(msg.sender);
        } else if (p.action == 3) {
            _setGuardians(p.ng0, p.ng1, p.ng2);
        } else if (p.action == 4) {
            // CB6: clear only the specified categories.
            _pausedCategoriesRaw &= ~p.categories;
            emit UnpausedCategory(msg.sender, p.categories);
            if (_pausedCategoriesRaw == 0) {
                pausedAtBlock = 0;
                emit Unpaused(msg.sender);
            }
        }
    }

    /// @notice CB6: propose unpause of a specific category subset. Same 2-of-3
    ///         approval as full unpause. Lets the council unpause governance
    ///         while leaving settlement paused (or vice versa) for triage.
    function proposeCategoryUnpause(uint8 categories) external returns (uint256 proposalId) {
        require(_isGuardian(msg.sender), "E18");
        require(categories != 0 && (categories & ~CAT_ALL) == 0, "E11");
        require((_activeMask() & categories) != 0, "E11"); // at least one must be active

        proposalId = ++_proposalNonce;
        Proposal storage p = _proposals[proposalId];
        p.action = 4;
        p.proposer = msg.sender;
        p.approvals = 1;
        p.categories = categories;
        p.voted[msg.sender] = true;
        emit PauseProposed(proposalId, 4, msg.sender);
    }

    // -------------------------------------------------------------------------
    // A5: guardian self-rotation (action == 3)
    // -------------------------------------------------------------------------

    /// @notice Sitting guardian proposes a new guardian set. Any single sitting
    ///         guardian can propose; activation requires a second approval.
    ///         Works regardless of `guardianSetLocked` — that flag only blocks
    ///         the owner-only `setGuardians` bootstrap path.
    function proposeGuardianRotation(address ng0, address ng1, address ng2) external returns (uint256 proposalId) {
        require(_isGuardian(msg.sender), "E18");
        require(ng0 != address(0) && ng1 != address(0) && ng2 != address(0), "E00");
        require(ng0 != ng1 && ng1 != ng2 && ng0 != ng2, "E11");

        proposalId = ++_proposalNonce;
        Proposal storage p = _proposals[proposalId];
        p.action = 3;
        p.proposer = msg.sender;
        p.approvals = 1;
        p.ng0 = ng0;
        p.ng1 = ng1;
        p.ng2 = ng2;
        p.voted[msg.sender] = true;
        emit GuardianRotationProposed(proposalId, msg.sender, ng0, ng1, ng2);
    }
}
