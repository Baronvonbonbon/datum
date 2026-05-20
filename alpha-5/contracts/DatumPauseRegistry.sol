// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";

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
contract DatumPauseRegistry is DatumUpgradable {

    /// @notice Upgrade ladder version. Note: this contract's own `paused()`
    ///         function is the category-mask pause (existing API, unchanged).
    ///         DatumUpgradable's migration-pause uses `frozen()` instead, so
    ///         no collision.
    function version() public pure override returns (uint256) { return 1; }

    /// @dev CB6: per-category pause bitfield. `paused()` returns true iff any
    ///      active category remains within its effective expiry window.
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

    /// @notice Ceiling on every pause-parameter setter. ~14 days at 6s/block
    ///         (14400 blocks/day × 14). No setter can exceed this; no
    ///         category cap exceeds this; no extension exceeds this; no
    ///         cooldown exceeds this.
    uint64 public constant MAX_PAUSE_PARAM_CEILING = 201600;
    /// @notice Backward-compat alias. Previously the single uniform expiry
    ///         constant; replaced by per-category caps + extension proposals
    ///         (G-2 first close, 2026-05-20). Kept as a publicly-visible
    ///         ceiling for tooling that read the old name.
    uint256 public constant MAX_PAUSE_BLOCKS = 201600;

    // ── G-2 first close (2026-05-20): tighter pause damage bounds ───────
    // Solo fast-pause window — short. A single guardian can pause this many
    // blocks; extending past that requires a 2-of-3 extend proposal
    // (action == 5). Bounded by MAX_PAUSE_PARAM_CEILING; governance-settable
    // pre-`lockPauseParams`.
    uint64 public soloMaxPauseBlocks;
    /// @notice Per-category extended cap (reached via 2-of-3 extend proposal).
    ///         Different categories have different damage profiles; settlement
    ///         pause stops user payouts (high cost), governance pause stops
    ///         vote resolution (low cost in steady-state).
    mapping(uint8 => uint64) public categoryMaxPauseBlocks;
    /// @notice Per-guardian per-category cooldown after a previous engagement.
    ///         Closes the "extend indefinitely by re-engaging at expiry"
    ///         attack. Same guardian cannot re-pause same category until
    ///         `lastEngagedBlock + soloMaxPauseBlocks + reengagementCooldownBlocks`.
    uint64 public reengagementCooldownBlocks;
    /// @notice Per-category extended end-block, set non-zero by an executed
    ///         2-of-3 extend proposal. Overrides the solo cap for that
    ///         category until the next fresh engagement resets it.
    mapping(uint8 => uint64) public extendedUntilBlock;
    /// @notice Per-(category, guardian) block of the most recent engagement.
    ///         Drives the re-engagement cooldown check.
    mapping(uint8 => mapping(address => uint64)) public lastEngagedBlock;
    /// @notice G-2 cypherpunk lock — freezes pause-parameter setters
    ///         permanently. Phase-gated on OpenGov via DatumUpgradable.
    bool public pauseParamsLocked;

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
    // G-2 events
    event PauseExtended(address indexed by, uint8 indexed categories, uint64 until);
    event SoloMaxPauseBlocksSet(uint64 blocks_);
    event CategoryMaxPauseBlocksSet(uint8 indexed category, uint64 blocks_);
    event ReengagementCooldownBlocksSet(uint64 blocks_);
    event PauseParamsLocked();

    constructor(address g0, address g1, address g2) {
        _setGuardians(g0, g1, g2);
        // G-2 defaults: solo 24h, settlement extended 3d, campaign-creation
        // and governance extended 7d, token-mint extended 14d. Cooldown 7d.
        // All bounded by MAX_PAUSE_PARAM_CEILING (~14d).
        soloMaxPauseBlocks = 14400;                      // ~24h @ 6s
        categoryMaxPauseBlocks[CAT_SETTLEMENT]        = 43200;   // ~3d
        categoryMaxPauseBlocks[CAT_CAMPAIGN_CREATION] = 100800;  // ~7d
        categoryMaxPauseBlocks[CAT_GOVERNANCE]        = 100800;  // ~7d
        categoryMaxPauseBlocks[CAT_TOKEN_MINT]        = 201600;  // ~14d
        reengagementCooldownBlocks = 100800;             // ~7d
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
    function lockGuardianSet() external onlyOwner whenOpenGovPhase {
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
    function pauseFast() external whenNotFrozen {
        require(_isGuardian(msg.sender), "E18");
        _engage(msg.sender, CAT_ALL);
    }

    /// @notice CB6: per-category fast-pause. Any guardian can pause a subset
    ///         of categories, limiting blast radius. `categories` is a
    ///         bitfield of CAT_* constants.
    function pauseFastCategories(uint8 categories) external whenNotFrozen {
        require(_isGuardian(msg.sender), "E18");
        require(categories != 0 && (categories & ~CAT_ALL) == 0, "E11");
        _engage(msg.sender, categories);
    }

    /// @notice Owner solo pause — kept for emergency response by the deploying
    ///         party. Engages every category. Unpause still requires guardian
    ///         quorum, so even an attacker who steals the owner key can only
    ///         ratchet the system into pause; recovery remains gated on the
    ///         (potentially rotated) guardians.
    /// @dev    G-2: the owner-pause path bypasses the per-(guardian, category)
    ///         cooldown. This is by design — even when the owner happens to
    ///         also sit on the guardian set, the owner-pause role is the
    ///         bootstrap-emergency path and shouldn't be rate-limited by the
    ///         guardian cooldown mechanism. The cooldown attaches to the
    ///         guardian fast-pause flow specifically.
    function pause() external onlyOwner whenNotFrozen {
        _engageNoCooldown(msg.sender, CAT_ALL);
    }

    /// @dev Owner-pause helper. Same effect as `_engage` minus the cooldown
    ///      check. Still resets extendedUntilBlock so any prior 2-of-3
    ///      extension is dropped — a fresh owner-pause is a fresh window.
    function _engageNoCooldown(address by, uint8 categories) internal {
        require(categories != 0, "E11");
        if (categories & CAT_SETTLEMENT        != 0) _engageCategory(CAT_SETTLEMENT);
        if (categories & CAT_CAMPAIGN_CREATION != 0) _engageCategory(CAT_CAMPAIGN_CREATION);
        if (categories & CAT_GOVERNANCE        != 0) _engageCategory(CAT_GOVERNANCE);
        if (categories & CAT_TOKEN_MINT        != 0) _engageCategory(CAT_TOKEN_MINT);
        _pausedCategoriesRaw |= categories;
        pausedAtBlock = block.number;
        emit PausedCategory(by, categories);
        emit Paused(by);
    }

    /// @dev Internal helper: OR `categories` into the bitfield and refresh the
    ///      engagement block for each. G-2: enforces per-(guardian, category)
    ///      re-engagement cooldown; resets extendedUntilBlock so the new
    ///      pause starts in the solo window (extension requires fresh 2-of-3).
    function _engage(address by, uint8 categories) internal {
        require(categories != 0, "E11");
        // G-2 cooldown: per-(category, guardian). Skipped for owner pause()
        // path — owner is bootstrap-emergency and not in the cooldown set.
        bool isG = _isGuardian(by);
        if (categories & CAT_SETTLEMENT        != 0) { if (isG) _checkAndRecordCooldown(CAT_SETTLEMENT,        by); _engageCategory(CAT_SETTLEMENT); }
        if (categories & CAT_CAMPAIGN_CREATION != 0) { if (isG) _checkAndRecordCooldown(CAT_CAMPAIGN_CREATION, by); _engageCategory(CAT_CAMPAIGN_CREATION); }
        if (categories & CAT_GOVERNANCE        != 0) { if (isG) _checkAndRecordCooldown(CAT_GOVERNANCE,        by); _engageCategory(CAT_GOVERNANCE); }
        if (categories & CAT_TOKEN_MINT        != 0) { if (isG) _checkAndRecordCooldown(CAT_TOKEN_MINT,        by); _engageCategory(CAT_TOKEN_MINT); }
        _pausedCategoriesRaw |= categories;
        pausedAtBlock = block.number;
        emit PausedCategory(by, categories);
        emit Paused(by);
    }

    /// @dev G-2 cooldown enforcement. The same guardian cannot re-pause the
    ///      same category until `lastEngagedBlock + soloMaxPauseBlocks +
    ///      reengagementCooldownBlocks` has elapsed. Closes the "extend
    ///      indefinitely by re-engaging at expiry" attack on G-2.
    function _checkAndRecordCooldown(uint8 cat, address by) internal {
        uint64 last = lastEngagedBlock[cat][by];
        if (last != 0) {
            uint256 readyAt = uint256(last) + uint256(soloMaxPauseBlocks) + uint256(reengagementCooldownBlocks);
            require(block.number > readyAt, "cooldown");
        }
        lastEngagedBlock[cat][by] = uint64(block.number);
    }

    /// @dev G-2: a fresh engagement on a category resets `extendedUntilBlock`
    ///      to zero — the new pause starts in the solo window, and the
    ///      2-of-3 cabal must re-propose to extend.
    function _engageCategory(uint8 cat) internal {
        pausedAtBlockFor[cat] = block.number;
        extendedUntilBlock[cat] = 0;
    }

    /// @notice CB6 + G-2: bitfield of currently-active (within-window)
    ///         categories. Effective end-block per category:
    ///           extendedUntilBlock[cat] != 0 → use it (2-of-3 extension)
    ///           otherwise                    → pausedAtBlockFor[cat] + soloMaxPauseBlocks
    function _activeMask() internal view returns (uint8 mask) {
        uint8 raw = _pausedCategoriesRaw;
        if (raw == 0) return 0;
        if (raw & CAT_SETTLEMENT        != 0 && _categoryActive(CAT_SETTLEMENT))        mask |= CAT_SETTLEMENT;
        if (raw & CAT_CAMPAIGN_CREATION != 0 && _categoryActive(CAT_CAMPAIGN_CREATION)) mask |= CAT_CAMPAIGN_CREATION;
        if (raw & CAT_GOVERNANCE        != 0 && _categoryActive(CAT_GOVERNANCE))        mask |= CAT_GOVERNANCE;
        if (raw & CAT_TOKEN_MINT        != 0 && _categoryActive(CAT_TOKEN_MINT))        mask |= CAT_TOKEN_MINT;
    }

    function _categoryActive(uint8 cat) internal view returns (bool) {
        uint256 effEnd = extendedUntilBlock[cat];
        if (effEnd == 0) effEnd = pausedAtBlockFor[cat] + uint256(soloMaxPauseBlocks);
        return block.number <= effEnd;
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

    /// @notice M-7 audit fix: permissionless cleanup of stale (expired) raw
    ///         category bits. `paused()` already masks expired bits via
    ///         `_activeMask`, but the raw bitfield can drift indefinitely
    ///         after auto-expiry, confusing observers reading
    ///         `_pausedCategoriesRaw` directly. Anyone can call this to
    ///         reconcile raw state with effective state.
    function expireStaleCategories() external whenNotFrozen {
        uint8 raw = _pausedCategoriesRaw;
        if (raw == 0) return;
        uint8 active = _activeMask();
        if (raw == active) return;
        _pausedCategoriesRaw = active;
        if (active == 0) {
            pausedAtBlock = 0;
            emit Unpaused(msg.sender);
        }
        emit UnpausedCategory(msg.sender, raw & ~active);
    }

    // -------------------------------------------------------------------------
    // SM-6: 2-of-3 guardian unpause (action == 2)
    // -------------------------------------------------------------------------

    /// @notice Propose an unpause (action=2). Pause is intentionally not a
    ///         valid action here — use `pauseFast` instead.
    function propose(uint8 action) external whenNotFrozen returns (uint256 proposalId) {
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
    function approve(uint256 proposalId) external whenNotFrozen {
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
        } else if (p.action == 5) {
            // G-2: every targeted category must still be active.
            require((_activeMask() & p.categories) == p.categories, "E11");
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
            // G-2: a 2-of-3 unpause is an explicit dismissal — clear the
            // per-(guardian, category) cooldown clock so guardians aren't
            // penalized for an engagement the consensus voted to reverse.
            // Also clear extendedUntilBlock so a future engagement starts
            // fresh in the solo window.
            _clearCooldownAndExtension(cleared);
            emit UnpausedCategory(msg.sender, cleared);
            emit Unpaused(msg.sender);
        } else if (p.action == 3) {
            _setGuardians(p.ng0, p.ng1, p.ng2);
        } else if (p.action == 4) {
            // CB6: clear only the specified categories.
            _pausedCategoriesRaw &= ~p.categories;
            // G-2: same dismissal-clear, scoped to the unpaused categories.
            _clearCooldownAndExtension(p.categories);
            emit UnpausedCategory(msg.sender, p.categories);
            if (_pausedCategoriesRaw == 0) {
                pausedAtBlock = 0;
                emit Unpaused(msg.sender);
            }
        } else if (p.action == 5) {
            // G-2: extend per-category caps for the listed bits.
            uint64 until = 0;
            if (p.categories & CAT_SETTLEMENT        != 0) { _extendCategory(CAT_SETTLEMENT);        if (extendedUntilBlock[CAT_SETTLEMENT]        > until) until = extendedUntilBlock[CAT_SETTLEMENT]; }
            if (p.categories & CAT_CAMPAIGN_CREATION != 0) { _extendCategory(CAT_CAMPAIGN_CREATION); if (extendedUntilBlock[CAT_CAMPAIGN_CREATION] > until) until = extendedUntilBlock[CAT_CAMPAIGN_CREATION]; }
            if (p.categories & CAT_GOVERNANCE        != 0) { _extendCategory(CAT_GOVERNANCE);        if (extendedUntilBlock[CAT_GOVERNANCE]        > until) until = extendedUntilBlock[CAT_GOVERNANCE]; }
            if (p.categories & CAT_TOKEN_MINT        != 0) { _extendCategory(CAT_TOKEN_MINT);        if (extendedUntilBlock[CAT_TOKEN_MINT]        > until) until = extendedUntilBlock[CAT_TOKEN_MINT]; }
            emit PauseExtended(msg.sender, p.categories, until);
        }
    }

    /// @dev G-2 helper: bump the extended end-block for a category. Uses
    ///      max() so a second extend doesn't shrink an already-longer one.
    function _extendCategory(uint8 cat) internal {
        uint256 newEnd = pausedAtBlockFor[cat] + uint256(categoryMaxPauseBlocks[cat]);
        if (newEnd > uint256(extendedUntilBlock[cat])) {
            extendedUntilBlock[cat] = uint64(newEnd);
        }
    }

    /// @dev G-2 helper: invoked from action-2 and action-4 unpause execution.
    ///      Clears the per-(guardian, category) cooldown clock and the
    ///      extension end-block for every category in the bitfield. The
    ///      semantic intent: a consensus unpause dismisses the pause, so
    ///      guardians shouldn't carry the cooldown penalty into a future
    ///      engagement, and any extension is invalidated by definition.
    function _clearCooldownAndExtension(uint8 categories) internal {
        if (categories == 0) return;
        // Per-category clear of extension end-block.
        if (categories & CAT_SETTLEMENT        != 0) extendedUntilBlock[CAT_SETTLEMENT]        = 0;
        if (categories & CAT_CAMPAIGN_CREATION != 0) extendedUntilBlock[CAT_CAMPAIGN_CREATION] = 0;
        if (categories & CAT_GOVERNANCE        != 0) extendedUntilBlock[CAT_GOVERNANCE]        = 0;
        if (categories & CAT_TOKEN_MINT        != 0) extendedUntilBlock[CAT_TOKEN_MINT]        = 0;
        // Per-guardian cooldown clear. We only need to clear the THREE current
        // guardians' entries — historical guardians (post-rotation) are
        // irrelevant for cooldown.
        address g0 = guardians[0]; address g1 = guardians[1]; address g2 = guardians[2];
        if (categories & CAT_SETTLEMENT != 0) {
            lastEngagedBlock[CAT_SETTLEMENT][g0] = 0;
            lastEngagedBlock[CAT_SETTLEMENT][g1] = 0;
            lastEngagedBlock[CAT_SETTLEMENT][g2] = 0;
        }
        if (categories & CAT_CAMPAIGN_CREATION != 0) {
            lastEngagedBlock[CAT_CAMPAIGN_CREATION][g0] = 0;
            lastEngagedBlock[CAT_CAMPAIGN_CREATION][g1] = 0;
            lastEngagedBlock[CAT_CAMPAIGN_CREATION][g2] = 0;
        }
        if (categories & CAT_GOVERNANCE != 0) {
            lastEngagedBlock[CAT_GOVERNANCE][g0] = 0;
            lastEngagedBlock[CAT_GOVERNANCE][g1] = 0;
            lastEngagedBlock[CAT_GOVERNANCE][g2] = 0;
        }
        if (categories & CAT_TOKEN_MINT != 0) {
            lastEngagedBlock[CAT_TOKEN_MINT][g0] = 0;
            lastEngagedBlock[CAT_TOKEN_MINT][g1] = 0;
            lastEngagedBlock[CAT_TOKEN_MINT][g2] = 0;
        }
    }

    /// @notice G-2: propose extending the pause window for a category subset.
    ///         Solo fast-pause caps at `soloMaxPauseBlocks` (~24h default);
    ///         this proposal type bumps the effective end-block to
    ///         `pausedAtBlockFor[cat] + categoryMaxPauseBlocks[cat]` per
    ///         targeted category. 2-of-3 approval — same proposal type as
    ///         unpause, just a different action.
    function proposeExtendPause(uint8 categories) external whenNotFrozen returns (uint256 proposalId) {
        require(_isGuardian(msg.sender), "E18");
        require(categories != 0 && (categories & ~CAT_ALL) == 0, "E11");
        // Every targeted category must be currently active.
        require((_activeMask() & categories) == categories, "E11");

        proposalId = ++_proposalNonce;
        Proposal storage p = _proposals[proposalId];
        p.action = 5;
        p.proposer = msg.sender;
        p.approvals = 1;
        p.categories = categories;
        p.voted[msg.sender] = true;
        emit PauseProposed(proposalId, 5, msg.sender);
    }

    /// @notice CB6: propose unpause of a specific category subset. Same 2-of-3
    ///         approval as full unpause. Lets the council unpause governance
    ///         while leaving settlement paused (or vice versa) for triage.
    function proposeCategoryUnpause(uint8 categories) external whenNotFrozen returns (uint256 proposalId) {
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
    function proposeGuardianRotation(address ng0, address ng1, address ng2) external whenNotFrozen returns (uint256 proposalId) {
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

    // -------------------------------------------------------------------------
    // G-2: pause-parameter governance (owner-only, lock-once)
    // -------------------------------------------------------------------------

    /// @notice Set the solo (1-of-N) fast-pause window in blocks. Bounded
    ///         by MAX_PAUSE_PARAM_CEILING (~14d).
    function setSoloMaxPauseBlocks(uint64 b) external onlyOwner whenNotFrozen {
        require(!pauseParamsLocked, "locked");
        require(b > 0 && b <= MAX_PAUSE_PARAM_CEILING, "E11");
        soloMaxPauseBlocks = b;
        emit SoloMaxPauseBlocksSet(b);
    }

    /// @notice Set the per-category extended cap reached via 2-of-3 extend
    ///         proposal. Must be >= soloMaxPauseBlocks (extension can never
    ///         shrink the solo window) and <= MAX_PAUSE_PARAM_CEILING.
    ///         `category` must be exactly one CAT_* bit.
    function setCategoryMaxPauseBlocks(uint8 category, uint64 b) external onlyOwner whenNotFrozen {
        require(!pauseParamsLocked, "locked");
        require(category != 0 && (category & ~CAT_ALL) == 0, "E11");
        // Must be a single bit (no compound categories).
        require((category & (category - 1)) == 0, "E11");
        require(b >= soloMaxPauseBlocks && b <= MAX_PAUSE_PARAM_CEILING, "E11");
        categoryMaxPauseBlocks[category] = b;
        emit CategoryMaxPauseBlocksSet(category, b);
    }

    /// @notice Set the per-(guardian, category) re-engagement cooldown in
    ///         blocks. Closes the "extend indefinitely by re-engaging at
    ///         expiry" attack. 0 = cooldown disabled (testnet only).
    function setReengagementCooldownBlocks(uint64 b) external onlyOwner whenNotFrozen {
        require(!pauseParamsLocked, "locked");
        require(b <= MAX_PAUSE_PARAM_CEILING, "E11");
        reengagementCooldownBlocks = b;
        emit ReengagementCooldownBlocksSet(b);
    }

    /// @notice Cypherpunk lock: freeze all G-2 pause-parameter setters
    ///         permanently. Phase-gated on OpenGov.
    function lockPauseParams() external onlyOwner whenOpenGovPhase {
        require(!pauseParamsLocked, "already locked");
        pauseParamsLocked = true;
        emit PauseParamsLocked();
    }
}
