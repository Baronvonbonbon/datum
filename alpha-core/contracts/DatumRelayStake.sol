// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumFundMigratable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumRelayStake.sol";

/// @title  DatumRelayStake
/// @notice G-1 first close: bond gate + slash hook for the relay role.
///         Mirrors DatumPublisherStake / DatumAdvertiserStake in shape.
///         Flat minimum stake (no bonding curve — relay adversarial
///         power is not a function of cumulative throughput).
///
///         Two roles consume this contract:
///           1. DatumRelay reads `isAuthorized(addr)` to gate its
///              authorized-relayer set (pattern (b) augment: pass if
///              EITHER manually authorized OR adequately staked).
///           2. DatumRelayGovernance calls `slash(...)` when a fraud
///              proposal resolves with ayes ≥ quorum and ayes > nays.
///              Governance receives the full slashed amount and handles
///              the challenger / treasury split off-side (mirrors the
///              PublisherStake → PublisherGovernance flow).
///
///         MAX_PUNISHMENT_BPS = 8000 guarantees ≥ 20% refund floor on
///         every slash call — no 100% wipeouts expressible from the
///         governance side. Repeated slashes can still drain the bond
///         to zero across multiple proposals.
///
///         Cypherpunk locks:
///           - lockStakeGate()  → relayMinStake becomes immutable.
///           - lockPlumbing()   → relayContractAddr / governance freeze.
///         Both phase-gated on OpenGov via DatumUpgradable.whenOpenGovPhase.
contract DatumRelayStake is
    IDatumRelayStake,
    PaseoSafeSender,
    DatumFundMigratable
{
    function version() public pure virtual override returns (uint256) { return 1; }

    // ── Wiring (lock-once via plumbingLocked) ───────────────────────────
    address public relayContractAddr;           // DatumRelay
    address public governance;                  // DatumRelayGovernance
    // plumbingLocked + PlumbingLocked now provided by DatumPlumbingLockable.
    bool public stakeGateLocked;

    // ── Parameters (governable, bounded) ────────────────────────────────
    uint256 public override relayMinStake;
    uint64  public override exitDelay;

    uint16 public constant MAX_PUNISHMENT_BPS = 8000;
    uint64 public constant MAX_EXIT_DELAY     = 1_209_600; // ~84d

    // ── State ───────────────────────────────────────────────────────────
    mapping(address => Stake) private _stake;
    address[] public relayList;
    mapping(address => uint256) private _relayIndex; // 1-based
    uint256 public override totalStaked;

    // ── Errors ──────────────────────────────────────────────────────────
    error E00();            // address(0) / generic
    error E03();            // zero balance / nothing to pull
    error E11();            // invalid parameter
    error E18();            // unauthorized (not governance)
    error E68();            // already pending
    error E70();            // delay not elapsed
    error LockedAlready();
    error PendingExit();
    error NotPending();

    // ── Constructor ─────────────────────────────────────────────────────
    constructor(
        uint256 _relayMinStake,
        uint64  _exitDelay
    ) DatumOwnable() {
        if (_exitDelay == 0 || _exitDelay > MAX_EXIT_DELAY) revert E11();
        relayMinStake = _relayMinStake;
        exitDelay = _exitDelay;
    }

    receive() external payable whenNotFrozen { revert E11(); }

    // ── Wiring setters ──────────────────────────────────────────────────
    function setRelayContract(address relay_) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (relay_ == address(0)) revert E00();
        relayContractAddr = relay_;
        emit RelayContractSet(relay_);
    }

    function setGovernance(address gov) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (gov == address(0)) revert E00();
        governance = gov;
        emit GovernanceSet(gov);
    }

    function lockPlumbing() external override onlyOwner whenOpenGovPhase {
        if (relayContractAddr == address(0)) revert E00();
        if (governance == address(0)) revert E00();
        _lockPlumbing();
    }

    // ── Parameter setters ───────────────────────────────────────────────
    function setRelayMinStake(uint256 floor_) external onlyOwner whenNotFrozen {
        if (stakeGateLocked) revert LockedAlready();
        relayMinStake = floor_;
        emit RelayMinStakeSet(floor_);
    }

    function setExitDelay(uint64 d) external onlyOwner whenNotFrozen {
        if (d == 0 || d > MAX_EXIT_DELAY) revert E11();
        exitDelay = d;
        emit ExitDelaySet(d);
    }

    function lockStakeGate() external onlyOwner whenOpenGovPhase {
        if (stakeGateLocked) revert LockedAlready();
        stakeGateLocked = true;
        emit StakeGateLocked();
    }

    // ── Relay actions ───────────────────────────────────────────────────
    /// @notice Initial stake. Adds caller to the relay list if new.
    function stake() external payable nonReentrant whenNotFrozen {
        if (msg.value == 0) revert E11();
        Stake storage s = _stake[msg.sender];
        if (s.exitRequestedBlock != 0) revert PendingExit();
        if (s.amount == 0) {
            s.joinedAtBlock = uint64(block.number);
            _relayIndex[msg.sender] = relayList.length + 1;
            relayList.push(msg.sender);
        }
        s.amount += msg.value;
        totalStaked += msg.value;
        emit RelayStaked(msg.sender, msg.value, s.amount);
    }

    /// @notice Add to existing stake. Idempotent for already-registered relays.
    function topUp() external payable nonReentrant whenNotFrozen {
        if (msg.value == 0) revert E11();
        Stake storage s = _stake[msg.sender];
        if (s.amount == 0) revert E03();
        if (s.exitRequestedBlock != 0) revert PendingExit();
        s.amount += msg.value;
        totalStaked += msg.value;
        emit RelayToppedUp(msg.sender, msg.value, s.amount);
    }

    /// @notice Initiate exit. Stake stays locked but isAuthorized returns
    ///         false immediately. Slash applies during the delay — exit
    ///         is NOT a slash escape.
    function requestExit() external nonReentrant whenNotFrozen {
        Stake storage s = _stake[msg.sender];
        if (s.amount == 0) revert E03();
        if (s.exitRequestedBlock != 0) revert E68();
        uint64 finalizeBlock = uint64(block.number) + exitDelay;
        s.exitRequestedBlock = uint64(block.number);
        emit ExitRequested(msg.sender, finalizeBlock);
    }

    function cancelExit() external nonReentrant whenNotFrozen {
        Stake storage s = _stake[msg.sender];
        if (s.exitRequestedBlock == 0) revert NotPending();
        s.exitRequestedBlock = 0;
        emit ExitCancelled(msg.sender);
    }

    /// @notice Finalize exit after delay. Refunds the remaining stake
    ///         (slashes during the delay already reduced it).
    function finalizeExit() external nonReentrant whenNotFrozen {
        Stake storage s = _stake[msg.sender];
        if (s.exitRequestedBlock == 0) revert NotPending();
        if (block.number < uint256(s.exitRequestedBlock) + uint256(exitDelay)) revert E70();
        uint256 refund = s.amount;
        totalStaked -= refund;
        _removeRelay(msg.sender);
        emit ExitFinalized(msg.sender, refund);
        if (refund > 0) {
            _safeSend(msg.sender, refund);
        }
    }

    /// @dev O(1) swap-remove from the iteration list. Also deletes the
    ///      Stake struct so a re-stake starts fresh.
    function _removeRelay(address relay) internal {
        uint256 idx1 = _relayIndex[relay];
        if (idx1 == 0) return;
        uint256 idx = idx1 - 1;
        uint256 last = relayList.length - 1;
        if (idx != last) {
            address moved = relayList[last];
            relayList[idx] = moved;
            _relayIndex[moved] = idx + 1;
        }
        relayList.pop();
        delete _relayIndex[relay];
        delete _stake[relay];
    }

    // ── Governance slash hook ───────────────────────────────────────────
    /// @notice Slash `amount` from `relay`'s stake; transfer to `recipient`.
    ///         Internally capped at MAX_PUNISHMENT_BPS (80%) of current
    ///         stake per call — refund floor preserved. Governance handles
    ///         challenger/treasury distribution on its own side.
    function slash(
        address relay,
        uint256 amount,
        address recipient,
        uint8 reasonCode
    ) external nonReentrant whenNotFrozen returns (uint256 slashed) {
        if (msg.sender != governance) revert E18();
        if (relay == address(0)) revert E00();
        if (recipient == address(0)) revert E00();
        Stake storage s = _stake[relay];
        uint256 active = s.amount;
        if (active == 0 || amount == 0) return 0;

        // Refund-floor cap: per call, ≤ MAX_PUNISHMENT_BPS of current stake.
        uint256 callCap = (active * uint256(MAX_PUNISHMENT_BPS)) / 10000;
        slashed = amount > callCap ? callCap : amount;
        if (slashed == 0) return 0;

        s.amount = active - slashed;
        totalStaked -= slashed;

        emit RelaySlashed(relay, slashed, recipient, reasonCode);
        _safeSend(recipient, slashed);
    }

    // ── Views ───────────────────────────────────────────────────────────
    /// @notice True iff the relay is staked at or above the floor AND has
    ///         NOT exit-requested. Consumed by DatumRelay's gate (pattern (b)
    ///         augment). Returns false when `relayMinStake == 0` so the
    ///         stake-gate adds no authorization until governance arms it.
    function isAuthorized(address relay) external view returns (bool) {
        if (relayMinStake == 0) return false;
        Stake storage s = _stake[relay];
        return s.amount >= relayMinStake && s.exitRequestedBlock == 0;
    }

    function stakeOf(address relay)
        external
        view
        returns (uint256 amount, uint64 joinedAtBlock, uint64 exitRequestedBlock)
    {
        Stake storage s = _stake[relay];
        return (s.amount, s.joinedAtBlock, s.exitRequestedBlock);
    }

    function relayListLength() external view returns (uint256) {
        return relayList.length;
    }

    // ── Upgrade migration (redeploy-migrate-rewire) ──────────────────────────

    /// @notice One-shot: true once native DOT has been swept to a successor.
    // fundsMigratedOut + migrateFundsTo + acceptMigration provided by DatumFundMigratable.

    /// @dev Copy params + every relay's Stake (reusing the existing enumerable
    ///      relayList) + totalStaked from a frozen predecessor. Wiring refs
    ///      (relayContractAddr / governance) are re-wired on the fresh contract.
    ///      Native DOT moves via `migrateFundsTo`.
    function _migrate(address oldContract) internal override {
        DatumRelayStake old = DatumRelayStake(payable(oldContract));
        relayMinStake = old.relayMinStake();
        exitDelay = old.exitDelay();
        uint256 n = old.relayListLength();
        for (uint256 i = 0; i < n; i++) {
            address r = old.relayList(i);
            (uint256 amount, uint64 joined, uint64 exitReq) = old.stakeOf(r);
            _stake[r] = Stake({amount: amount, joinedAtBlock: joined, exitRequestedBlock: exitReq});
            if (_relayIndex[r] == 0) {
                _relayIndex[r] = relayList.length + 1;
                relayList.push(r);
            }
        }
        totalStaked = old.totalStaked();
    }

    /// @notice Sweep native balance to a successor during an upgrade so it can
    ///         honour migrated relay stakes. Governance-gated, frozen-only, one-shot.
}
