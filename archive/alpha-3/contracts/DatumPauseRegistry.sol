// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumPauseRegistry
/// @notice Global emergency pause circuit breaker.
///         SM-6: pause/unpause require 2-of-3 guardian approval.
///
///         Guardian approval flow:
///         1. Any guardian calls propose(action) — records their vote, returns proposalId.
///         2. A second guardian calls approve(proposalId) — executes immediately.
///         3. Owner can update guardian set (owner itself should be a multisig for mainnet).
///         Replay protection: each proposal is single-use (deleted on execution).
///         All DATUM contracts check paused() via staticcall before critical operations.
contract DatumPauseRegistry is Ownable2Step {
    bool public paused;

    // SM-6: 2-of-3 guardian multisig for pause/unpause
    address[3] public guardians;
    uint256 private _proposalNonce;

    struct Proposal {
        uint8 action;     // 1 = pause, 2 = unpause
        address proposer;
        uint8 approvals;
        bool executed;    // AUDIT-021: replaces delete — prevents mapping ghost state
        mapping(address => bool) voted;
    }
    mapping(uint256 => Proposal) private _proposals;

    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event GuardiansUpdated(address g0, address g1, address g2);
    event PauseProposed(uint256 indexed proposalId, uint8 action, address indexed proposer);
    event PauseApproved(uint256 indexed proposalId, address indexed approver);

    constructor(address g0, address g1, address g2) Ownable(msg.sender) {
        _setGuardians(g0, g1, g2);
    }

    // -------------------------------------------------------------------------
    // Owner admin
    // -------------------------------------------------------------------------

    function setGuardians(address g0, address g1, address g2) external onlyOwner {
        _setGuardians(g0, g1, g2);
    }

    function _setGuardians(address g0, address g1, address g2) internal {
        require(g0 != address(0) && g1 != address(0) && g2 != address(0), "E00");
        require(g0 != g1 && g1 != g2 && g0 != g2, "E11");
        guardians[0] = g0;
        guardians[1] = g1;
        guardians[2] = g2;
        emit GuardiansUpdated(g0, g1, g2);
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }

    // -------------------------------------------------------------------------
    // SM-6: 2-of-3 guardian pause/unpause
    // -------------------------------------------------------------------------

    function _isGuardian(address addr) internal view returns (bool) {
        return addr == guardians[0] || addr == guardians[1] || addr == guardians[2];
    }

    /// @notice Any guardian proposes a pause (action=1) or unpause (action=2).
    /// @return proposalId — pass to approve() for the second guardian's confirmation.
    function propose(uint8 action) external returns (uint256 proposalId) {
        require(_isGuardian(msg.sender), "E18");
        require(action == 1 || action == 2, "E11");
        // Invariant: don't propose if already in that state
        require(action == 1 ? !paused : paused, "E11");

        proposalId = ++_proposalNonce;
        Proposal storage p = _proposals[proposalId];
        p.action = action;
        p.proposer = msg.sender;
        p.approvals = 1;
        p.voted[msg.sender] = true;
        emit PauseProposed(proposalId, action, msg.sender);
    }

    /// @notice Second (or third) guardian approves a proposal.
    ///         Executes immediately when the 2nd approval arrives.
    function approve(uint256 proposalId) external {
        require(_isGuardian(msg.sender), "E18");
        Proposal storage p = _proposals[proposalId];
        require(p.action != 0, "E01");           // proposal exists
        require(!p.executed, "E11");             // AUDIT-021: not already executed
        require(!p.voted[msg.sender], "E11");    // not already voted
        // Validate state hasn't changed since proposal
        require(p.action == 1 ? !paused : paused, "E11");

        p.voted[msg.sender] = true;
        p.approvals++;
        emit PauseApproved(proposalId, msg.sender);

        if (p.approvals >= 2) {
            p.executed = true; // AUDIT-021: mark executed instead of delete (mapping can't be cleared)
            _execute(p.action);
        }
    }

    function _execute(uint8 action) internal {
        if (action == 1) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    /// @notice Emergency owner pause — protective action only (C-4: unpause removed).
    ///         Owner can pause the system instantly, but unpause always requires 2-of-3 guardians.
    ///         On mainnet, owner should be a Gnosis Safe multisig.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }
}
