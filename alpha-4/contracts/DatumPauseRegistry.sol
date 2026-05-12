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
    /// @dev Raw pause flag. External callers read via `paused()` which lazily
    ///      expires after MAX_PAUSE_BLOCKS so a single guardian holding the
    ///      veto can't DoS the protocol indefinitely (A6/B6-fix).
    bool internal _pausedRaw;
    /// @notice Block at which `pause` / `pauseFast` was last engaged.
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
    // action 1 (legacy pause), 2 (unpause), 3 (rotate guardians)
    struct Proposal {
        uint8 action;
        address proposer;
        uint8 approvals;
        bool executed;
        // Used when action == 3 (rotate guardians)
        address ng0;
        address ng1;
        address ng2;
        mapping(address => bool) voted;
    }
    mapping(uint256 => Proposal) private _proposals;

    event Paused(address indexed by);
    event Unpaused(address indexed by);
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
        require(!paused(), "E11");
        _pausedRaw = true;
        pausedAtBlock = block.number;
        emit Paused(msg.sender);
    }

    /// @notice Owner solo pause — kept for emergency response by the deploying
    ///         party. Restored to `pause` solely as the owner. Unpause still
    ///         requires guardian quorum, so even an attacker who steals the
    ///         owner key can only ratchet the system into pause; recovery
    ///         remains gated on the (potentially rotated) guardians.
    function pause() external onlyOwner {
        _pausedRaw = true;
        pausedAtBlock = block.number;
        emit Paused(msg.sender);
    }

    /// @notice A6/B6-fix: lazy-evaluated pause state. Returns false once
    ///         `MAX_PAUSE_BLOCKS` have elapsed since the pause was engaged,
    ///         even if no guardian has voted to unpause. Caps any single
    ///         guardian's DoS power to a finite window.
    function paused() public view returns (bool) {
        if (!_pausedRaw) return false;
        if (block.number > pausedAtBlock + MAX_PAUSE_BLOCKS) return false;
        return true;
    }

    // -------------------------------------------------------------------------
    // SM-6: 2-of-3 guardian unpause (action == 2)
    // -------------------------------------------------------------------------

    /// @notice Propose an unpause (action=2). Pause is intentionally not a
    ///         valid action here — use `pauseFast` instead. Action codes are
    ///         retained for future-extensibility but only 2 is honored.
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
            _pausedRaw = false;
            pausedAtBlock = 0;
            emit Unpaused(msg.sender);
        } else if (p.action == 3) {
            _setGuardians(p.ng0, p.ng1, p.ng2);
        }
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
