// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./interfaces/IDatumParameterGovernance.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";

/**
 * DatumParameterGovernance — T1-B
 *
 * Conviction-vote governance for FP system parameter changes.
 * This contract must be set as the owner of any contract whose setParams()
 * it governs (DatumPublisherStake, DatumPublisherGovernance, DatumNullifierRegistry).
 *
 * Governance flow:
 *   1. propose(target, payload, description) — pay proposeBond in DOT.
 *   2. vote(id, aye, conviction)             — deposit DOT, locked per conviction.
 *   3. After endBlock: resolve(id)           — Passed or Rejected.
 *   4. After executeAfter: execute(id)       — runs target.call(payload), bond refunded.
 *
 * Conviction multipliers (×1 to ×21) and lockups match DatumPublisherGovernance.
 * Error codes: E00 zero addr, E02 transfer fail, E03 zero value,
 *              E11 bad value, E18 not owner, E40 proposal state/condition error,
 *              E57 reentrancy.
 */
contract DatumParameterGovernance is IDatumParameterGovernance, DatumUpgradable, PaseoSafeSender {
    function version() public pure virtual override returns (uint256) { return 1; }


    // ── Conviction table ────────────────────────────────────────────────────────
    uint8 public constant MAX_CONVICTION = 8;

    function _weight(uint8 c) internal pure returns (uint256) {
        uint256[9] memory w = [uint256(1), 2, 3, 4, 6, 9, 14, 18, 21];
        return w[c];
    }

    function _lockup(uint8 c) internal pure returns (uint256) {
        uint256[9] memory l = [uint256(0), 14400, 43200, 100800, 302400, 1296000, 2592000, 3888000, 5256000];
        return l[c];
    }

    // ── Storage ─────────────────────────────────────────────────────────────────
    IDatumPauseRegistry public immutable pauseRegistry;

    // AUDIT-004: Whitelist — only permitted targets and selectors can be executed
    mapping(address => bool) public whitelistedTargets;
    mapping(address => mapping(bytes4 => bool)) public permittedSelectors;

    uint256 public votingPeriodBlocks;
    uint256 public timelockBlocks;
    uint256 public quorum;
    uint256 public proposeBond;

    uint256 public nextProposalId;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Vote)) private _votes;

    /// @dev G-M3: pull-pattern queue for bond refunds (proposer) and slashed
    ///      bonds (owner). Resolve / execute / cancel queue here instead of
    ///      pushing directly so a contract recipient with a hostile fallback
    ///      cannot DoS the lifecycle.
    mapping(address => uint256) public pendingBondPayout;
    event BondPayoutQueued(address indexed recipient, uint256 amount);
    event BondPayoutClaimed(address indexed recipient, address indexed to, uint256 amount);

    // ── Enumeration for upgrade migration ──
    // In-flight bonded votes lock DOT, so the full vote state is carried over;
    // the whitelist (target + selector allowlist) is copied so PG keeps its
    // execution permissions; bond payouts route through _queueBondPayout.
    mapping(uint256 => address[]) private _proposalVoters;
    mapping(uint256 => mapping(address => bool)) private _voterTracked;
    address[] private _bondPayoutHolders;
    mapping(address => bool) private _bondPayoutTracked;
    address[] private _whitelistTargets;
    mapping(address => bool) private _whitelistTargetTracked;
    mapping(address => bytes4[]) private _targetSelectors;
    mapping(address => mapping(bytes4 => bool)) private _targetSelectorTracked;
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    function _queueBondPayout(address a, uint256 amt) internal {
        pendingBondPayout[a] += amt;
        if (a != address(0) && !_bondPayoutTracked[a]) { _bondPayoutTracked[a] = true; _bondPayoutHolders.push(a); }
    }

    // ── Modifiers ───────────────────────────────────────────────────────────────
    modifier whenNotPaused() { require(!pauseRegistry.pausedGovernance(), "P"); _; }

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(
        address _pauseRegistry,
        uint256 _votingPeriodBlocks,
        uint256 _timelockBlocks,
        uint256 _quorum,
        uint256 _proposeBond
    ) DatumOwnable() {
        require(_pauseRegistry != address(0), "E00");
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        votingPeriodBlocks = _votingPeriodBlocks;
        timelockBlocks = _timelockBlocks;
        quorum = _quorum;
        proposeBond = _proposeBond;
    }

    // ── Actions ──────────────────────────────────────────────────────────────────

    function propose(
        address target,
        bytes calldata payload,
        string calldata description
    ) external payable nonReentrant whenNotPaused returns (uint256 proposalId) {
        require(msg.value == proposeBond, "E11");
        require(target != address(0), "E00");
        require(payload.length >= 4, "E11");

        proposalId = nextProposalId++;
        Proposal storage p = _proposals[proposalId];
        p.proposer = msg.sender;
        p.target = target;
        p.payload = payload;
        p.description = description;
        p.startBlock = block.number;
        p.endBlock = block.number + votingPeriodBlocks;
        p.bond = msg.value;
        // p.state defaults to Active (0)

        emit Proposed(proposalId, msg.sender, target, description);
    }

    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable nonReentrant whenNotPaused {
        require(conviction <= MAX_CONVICTION, "E40");
        require(msg.value > 0, "E03");

        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Active, "E40");
        require(block.number <= p.endBlock, "E40");

        Vote storage v = _votes[proposalId][msg.sender];
        if (!_voterTracked[proposalId][msg.sender]) { _voterTracked[proposalId][msg.sender] = true; _proposalVoters[proposalId].push(msg.sender); }
        if (v.lockAmount > 0) {
            // Only allow re-vote if lock has expired
            require(block.number >= v.lockUntil, "E40");
            // Remove old weight
            uint256 oldWeight = v.lockAmount * _weight(v.conviction);
            if (v.aye) p.ayeWeight -= oldWeight; else p.nayWeight -= oldWeight;
            // Refund old deposit (Paseo-dust-safe; trailing dust queues).
            uint256 refund = v.lockAmount;
            v.lockAmount = 0;
            _safeSend(msg.sender, refund);
        }

        uint256 weight = msg.value * _weight(conviction);
        if (aye) p.ayeWeight += weight; else p.nayWeight += weight;

        v.aye = aye;
        v.conviction = conviction;
        v.lockAmount = msg.value;
        v.lockUntil = block.number + _lockup(conviction);

        emit Voted(proposalId, msg.sender, aye, msg.value, conviction);
    }

    function withdrawVote(uint256 proposalId) external nonReentrant whenNotFrozen {
        Vote storage v = _votes[proposalId][msg.sender];
        require(v.lockAmount > 0, "E03");
        require(block.number >= v.lockUntil, "E40");

        uint256 amount = v.lockAmount;
        v.lockAmount = 0;
        v.lockUntil = 0;

        _safeSend(msg.sender, amount);

        emit VoteWithdrawn(proposalId, msg.sender, amount);
    }

    function resolve(uint256 proposalId) external whenNotPaused whenNotFrozen {
        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Active, "E40");
        require(block.number > p.endBlock, "E40");

        if (p.ayeWeight >= quorum && p.ayeWeight > p.nayWeight) {
            p.state = State.Passed;
            p.executeAfter = block.number + timelockBlocks;
        } else {
            p.state = State.Rejected;
            // G-M3: queue slashed bond for owner pull instead of pushing.
            uint256 bond = p.bond;
            p.bond = 0;
            if (bond > 0) {
                _queueBondPayout(owner(), bond);
                emit BondPayoutQueued(owner(), bond);
            }
        }
        emit Resolved(proposalId, uint8(p.state));
    }

    function execute(uint256 proposalId) external nonReentrant whenNotPaused whenNotFrozen {
        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Passed, "E40");
        require(block.number >= p.executeAfter, "E40");

        p.state = State.Executed;

        // AUDIT-004: Validate target and selector before execution
        require(whitelistedTargets[p.target], "E75");
        bytes4 sel;
        bytes memory payload = p.payload;
        assembly { sel := mload(add(payload, 32)) }
        require(permittedSelectors[p.target][sel], "E76");

        // Execute the parameter change
        (bool ok,) = p.target.call(p.payload);
        require(ok, "E02");

        // G-M3: queue bond refund for proposer pull.
        uint256 bond = p.bond;
        p.bond = 0;
        if (bond > 0) {
            _queueBondPayout(p.proposer, bond);
            emit BondPayoutQueued(p.proposer, bond);
        }

        emit Executed(proposalId, p.target);
    }

    function cancel(uint256 proposalId) external onlyOwner nonReentrant {
        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Active || p.state == State.Passed, "E40");

        p.state = State.Cancelled;

        // G-M3: queue cancelled-bond payout for owner pull.
        uint256 bond = p.bond;
        p.bond = 0;
        if (bond > 0) {
            _queueBondPayout(owner(), bond);
            emit BondPayoutQueued(owner(), bond);
        }

        emit Cancelled(proposalId);
    }

    /// @notice G-M3: Pull a queued bond payout to msg.sender.
    function claimBondPayout() external nonReentrant whenNotFrozen {
        _claimBondPayout(msg.sender);
    }

    /// @notice G-M3: Pull a queued bond payout to a chosen recipient (cold wallet).
    function claimBondPayoutTo(address recipient) external nonReentrant whenNotFrozen {
        require(recipient != address(0), "E00");
        _claimBondPayout(recipient);
    }

    function _claimBondPayout(address recipient) internal {
        uint256 amount = pendingBondPayout[msg.sender];
        require(amount > 0, "E03");
        pendingBondPayout[msg.sender] = 0;
        emit BondPayoutClaimed(msg.sender, recipient, amount);
        _safeSend(recipient, amount);
    }

    // ── Admin ────────────────────────────────────────────────────────────────────

    // AUDIT-004: Whitelist management
    /// @notice F-036 fix (2026-05-20): one-way lock for the whitelist.
    ///         Once `whitelistLocked`, the owner can no longer add or
    ///         remove (target, selector) pairs — a captured owner can
    ///         no longer route new admin functions through the
    ///         parameter-governance pipeline. Phase-gated on OpenGov.
    bool public whitelistLocked;
    event WhitelistLocked();

    function setWhitelistedTarget(address target, bool allowed) external onlyOwner {
        require(!whitelistLocked, "whitelist-locked");
        require(target != address(0), "E00");
        whitelistedTargets[target] = allowed;
        if (allowed && !_whitelistTargetTracked[target]) { _whitelistTargetTracked[target] = true; _whitelistTargets.push(target); }
    }

    function setPermittedSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        require(!whitelistLocked, "whitelist-locked");
        require(target != address(0), "E00");
        permittedSelectors[target][selector] = allowed;
        if (allowed) {
            if (!_whitelistTargetTracked[target]) { _whitelistTargetTracked[target] = true; _whitelistTargets.push(target); }
            if (!_targetSelectorTracked[target][selector]) { _targetSelectorTracked[target][selector] = true; _targetSelectors[target].push(selector); }
        }
    }

    function lockWhitelist() external onlyOwner whenOpenGovPhase {
        require(!whitelistLocked, "already-locked");
        whitelistLocked = true;
        emit WhitelistLocked();
    }

    /// @notice Bootstrap helper — owner-only, lets this contract accept Ownable2Step
    ///         ownership of contracts whose params it governs.
    /// @dev    The pendingOwner of `target` must already be set to this contract
    ///         (via the prior owner calling `target.transferOwnership(thisContract)`).
    ///         This bypasses the propose/vote/execute lifecycle for the one-time
    ///         ownership migration so we don't run into the chicken-and-egg of
    ///         "the proposal to accept ownership requires the whitelist + a voting
    ///         period that runs on a contract we don't yet own."
    ///
    ///         Once this contract is itself transferred to a higher governor
    ///         (Timelock / Council), this bootstrap stops being callable, so the
    ///         power is naturally bounded by the owner's authority at the time.
    function bootstrapAcceptOwnership(address target) external onlyOwner {
        require(target != address(0), "E00");
        (bool ok,) = target.call(abi.encodeWithSignature("acceptOwnership()"));
        require(ok, "E02");
    }

    /// @notice F-035 fix (2026-05-20): hard floors so a captured owner
    ///         cannot collapse the governance pipeline by setting
    ///         quorum=0 / timelock=0 / votingPeriod=0 and then trivially
    ///         pass any whitelisted parameter change in one block.
    ///         Production values are set far above these floors; the
    ///         floors exist purely as anti-bypass guards.
    uint256 public constant MIN_VOTING_PERIOD_BLOCKS = 1;
    uint256 public constant MIN_TIMELOCK_BLOCKS = 1;
    uint256 public constant MIN_QUORUM = 1;
    /// @notice Maximum value any window setter accepts. Prevents a captured
    ///         owner from griefing governance by configuring absurdly long
    ///         windows. ~30 days at 6s/block.
    uint256 public constant MAX_GOVERNANCE_WINDOW_BLOCKS = 432_000;

    function setParams(
        uint256 _votingPeriodBlocks,
        uint256 _timelockBlocks,
        uint256 _quorum,
        uint256 _proposeBond
    ) external onlyOwner {
        require(_votingPeriodBlocks >= MIN_VOTING_PERIOD_BLOCKS, "E11");
        require(_votingPeriodBlocks <= MAX_GOVERNANCE_WINDOW_BLOCKS, "E11");
        require(_timelockBlocks >= MIN_TIMELOCK_BLOCKS, "E11");
        require(_timelockBlocks <= MAX_GOVERNANCE_WINDOW_BLOCKS, "E11");
        require(_quorum >= MIN_QUORUM, "E11");
        votingPeriodBlocks = _votingPeriodBlocks;
        timelockBlocks = _timelockBlocks;
        quorum = _quorum;
        proposeBond = _proposeBond;
        emit ParamsUpdated(_votingPeriodBlocks, _timelockBlocks, _quorum, _proposeBond);
    }

    // ── Views ────────────────────────────────────────────────────────────────────

    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVote(uint256 proposalId, address voter) external view returns (Vote memory) {
        return _votes[proposalId][voter];
    }

    function convictionWeight(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _weight(conviction);
    }

    function convictionLockup(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _lockup(conviction);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Upgrade migration (config + whitelist + in-flight votes + bond payouts)
    // ─────────────────────────────────────────────────────────────────────────

    function getProposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }
    function proposalVoterCount(uint256 id) external view returns (uint256) { return _proposalVoters[id].length; }
    function proposalVoterAt(uint256 id, uint256 i) external view returns (address) { return _proposalVoters[id][i]; }
    function bondPayoutHolderCount() external view returns (uint256) { return _bondPayoutHolders.length; }
    function bondPayoutHolderAt(uint256 i) external view returns (address) { return _bondPayoutHolders[i]; }
    function whitelistTargetCount() external view returns (uint256) { return _whitelistTargets.length; }
    function whitelistTargetAt(uint256 i) external view returns (address) { return _whitelistTargets[i]; }
    function targetSelectorCount(address t) external view returns (uint256) { return _targetSelectors[t].length; }
    function targetSelectorAt(address t, uint256 i) external view returns (bytes4) { return _targetSelectors[t][i]; }

    /// @dev Copy config + the target/selector whitelist + every proposal + its
    ///      bonded votes + pending bond payouts from a frozen predecessor.
    ///      In-flight bonded votes lock DOT (can't drain), so the full vote
    ///      state is carried over and the balance swept.
    function _migrate(address oldContract) internal override {
        DatumParameterGovernance old = DatumParameterGovernance(payable(oldContract));
        votingPeriodBlocks = old.votingPeriodBlocks();
        timelockBlocks = old.timelockBlocks();
        quorum = old.quorum();
        proposeBond = old.proposeBond();

        uint256 nt = old.whitelistTargetCount();
        for (uint256 i = 0; i < nt; i++) {
            address t = old.whitelistTargetAt(i);
            whitelistedTargets[t] = old.whitelistedTargets(t);
            if (!_whitelistTargetTracked[t]) { _whitelistTargetTracked[t] = true; _whitelistTargets.push(t); }
            uint256 ns = old.targetSelectorCount(t);
            for (uint256 j = 0; j < ns; j++) {
                bytes4 s = old.targetSelectorAt(t, j);
                permittedSelectors[t][s] = old.permittedSelectors(t, s);
                if (!_targetSelectorTracked[t][s]) { _targetSelectorTracked[t][s] = true; _targetSelectors[t].push(s); }
            }
        }

        nextProposalId = old.nextProposalId();
        for (uint256 id = 0; id < nextProposalId; id++) { // PG proposal ids are 0-based
            _proposals[id] = old.getProposal(id);
            uint256 vn = old.proposalVoterCount(id);
            for (uint256 j = 0; j < vn; j++) {
                address voter = old.proposalVoterAt(id, j);
                _votes[id][voter] = old.getVote(id, voter);
                if (!_voterTracked[id][voter]) { _voterTracked[id][voter] = true; _proposalVoters[id].push(voter); }
            }
        }

        uint256 pn = old.bondPayoutHolderCount();
        for (uint256 i = 0; i < pn; i++) {
            address a = old.bondPayoutHolderAt(i);
            pendingBondPayout[a] = old.pendingBondPayout(a);
            if (!_bondPayoutTracked[a]) { _bondPayoutTracked[a] = true; _bondPayoutHolders.push(a); }
        }
    }

    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumParameterGovernance(payable(successor)).acceptMigration{value: bal}();
    }

    function acceptMigration() external payable {
        require(msg.sender == migrationSource, "not-source");
    }
}
