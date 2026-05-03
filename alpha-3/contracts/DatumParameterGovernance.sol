// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./interfaces/IDatumParameterGovernance.sol";
import "./interfaces/IDatumPauseRegistry.sol";

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
contract DatumParameterGovernance is IDatumParameterGovernance {

    // ── Conviction table ────────────────────────────────────────────────────────
    uint8 public constant MAX_CONVICTION = 8;

    function _weight(uint8 c) internal pure returns (uint256) {
        if (c == 0) return 1;
        if (c == 1) return 2;
        if (c == 2) return 3;
        if (c == 3) return 4;
        if (c == 4) return 6;
        if (c == 5) return 9;
        if (c == 6) return 14;
        if (c == 7) return 18;
        return 21; // c == 8
    }

    // Lockup in blocks at 6 s/block: 0, 1d, 3d, 7d, 21d, 90d, 180d, 270d, 365d
    function _lockup(uint8 c) internal pure returns (uint256) {
        if (c == 0) return 0;
        if (c == 1) return 14_400;
        if (c == 2) return 43_200;
        if (c == 3) return 100_800;
        if (c == 4) return 302_400;
        if (c == 5) return 1_296_000;
        if (c == 6) return 2_592_000;
        if (c == 7) return 3_888_000;
        return 5_256_000; // c == 8, 365d
    }

    // ── Storage ─────────────────────────────────────────────────────────────────
    address public owner;
    address public pendingOwner;
    uint256 private _locked;

    IDatumPauseRegistry public pauseRegistry;

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

    // ── Modifiers ───────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 0, "E57");
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier whenNotPaused() { require(!pauseRegistry.paused(), "P"); _; }

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(
        address _pauseRegistry,
        uint256 _votingPeriodBlocks,
        uint256 _timelockBlocks,
        uint256 _quorum,
        uint256 _proposeBond
    ) {
        owner = msg.sender;
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
        if (v.lockAmount > 0) {
            // Only allow re-vote if lock has expired
            require(block.number >= v.lockUntil, "E40");
            // Remove old weight
            uint256 oldWeight = v.lockAmount * _weight(v.conviction);
            if (v.aye) p.ayeWeight -= oldWeight; else p.nayWeight -= oldWeight;
            // Refund old deposit
            uint256 refund = v.lockAmount;
            v.lockAmount = 0;
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "E02");
        }

        uint256 weight = msg.value * _weight(conviction);
        if (aye) p.ayeWeight += weight; else p.nayWeight += weight;

        v.aye = aye;
        v.conviction = conviction;
        v.lockAmount = msg.value;
        v.lockUntil = block.number + _lockup(conviction);

        emit Voted(proposalId, msg.sender, aye, msg.value, conviction);
    }

    function withdrawVote(uint256 proposalId) external nonReentrant {
        Vote storage v = _votes[proposalId][msg.sender];
        require(v.lockAmount > 0, "E03");
        require(block.number >= v.lockUntil, "E40");

        uint256 amount = v.lockAmount;
        v.lockAmount = 0;
        v.lockUntil = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "E02");

        emit VoteWithdrawn(proposalId, msg.sender, amount);
    }

    function resolve(uint256 proposalId) external whenNotPaused {
        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Active, "E40");
        require(block.number > p.endBlock, "E40");

        if (p.ayeWeight >= quorum && p.ayeWeight > p.nayWeight) {
            p.state = State.Passed;
            p.executeAfter = block.number + timelockBlocks;
        } else {
            p.state = State.Rejected;
            // Slash bond to owner
            uint256 bond = p.bond;
            p.bond = 0;
            (bool ok,) = owner.call{value: bond}("");
            require(ok, "E02");
        }
        emit Resolved(proposalId, uint8(p.state));
    }

    function execute(uint256 proposalId) external nonReentrant whenNotPaused {
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

        // Return bond to proposer
        uint256 bond = p.bond;
        p.bond = 0;
        address proposer = p.proposer;
        (bool refund,) = proposer.call{value: bond}("");
        require(refund, "E02");

        emit Executed(proposalId, p.target);
    }

    function cancel(uint256 proposalId) external onlyOwner nonReentrant {
        Proposal storage p = _proposals[proposalId];
        require(p.state == State.Active || p.state == State.Passed, "E40");

        p.state = State.Cancelled;

        uint256 bond = p.bond;
        p.bond = 0;
        (bool ok,) = owner.call{value: bond}("");
        require(ok, "E02");

        emit Cancelled(proposalId);
    }

    // ── Admin ────────────────────────────────────────────────────────────────────

    // AUDIT-004: Whitelist management
    function setWhitelistedTarget(address target, bool allowed) external onlyOwner {
        require(target != address(0), "E00");
        whitelistedTargets[target] = allowed;
    }

    function setPermittedSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        require(target != address(0), "E00");
        permittedSelectors[target][selector] = allowed;
    }

    function setParams(
        uint256 _votingPeriodBlocks,
        uint256 _timelockBlocks,
        uint256 _quorum,
        uint256 _proposeBond
    ) external onlyOwner {
        votingPeriodBlocks = _votingPeriodBlocks;
        timelockBlocks = _timelockBlocks;
        quorum = _quorum;
        proposeBond = _proposeBond;
        emit ParamsUpdated(_votingPeriodBlocks, _timelockBlocks, _quorum, _proposeBond);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = msg.sender;
        pendingOwner = address(0);
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
}
