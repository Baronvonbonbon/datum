// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumRelayStake
/// @notice G-1 first close: bond + slash gate for the relay role. Mirrors the
///         publisher / advertiser stake contracts but with a FLAT minimum
///         (no bonding curve) because relay adversarial power is not a
///         function of cumulative throughput.
///
///         Authorization model:
///           - `isAuthorized(relay)` returns true iff staked >= relayMinStake
///             AND no exit pending. DatumRelay consults this view to gate the
///             authorized-relayer set (pattern (b) augment: stake OR manual
///             authorization).
///           - `slash(relay, amount, recipient, reasonCode)` is callable only
///             by the wired governance contract (DatumRelayGovernance).
///             The full slashed amount goes to `recipient`; governance handles
///             the challenger / treasury split off-side. The slashed amount
///             is internally capped at MAX_PUNISHMENT_BPS = 8000 of the
///             relay's current stake — refund floor ≥ 20% always preserved.
interface IDatumRelayStake {
    event RelayStaked(address indexed relay, uint256 amount, uint256 newTotal);
    event RelayToppedUp(address indexed relay, uint256 amount, uint256 newTotal);
    event ExitRequested(address indexed relay, uint64 finalizeBlock);
    event ExitFinalized(address indexed relay, uint256 refund);
    event ExitCancelled(address indexed relay);
    event RelaySlashed(
        address indexed relay,
        uint256 amount,
        address indexed recipient,
        uint8 reasonCode
    );

    // Parameter setters / wiring events
    event RelayMinStakeSet(uint256 floor);
    event ExitDelaySet(uint64 blocks_);
    event RelayContractSet(address indexed relay);
    event GovernanceSet(address indexed governance);
    event StakeGateLocked();
    // PlumbingLocked is provided by DatumPlumbingLockable (the contract emits it).

    struct Stake {
        uint256 amount;
        uint64  joinedAtBlock;
        uint64  exitRequestedBlock; // 0 = active
    }

    // ── Relay actions ───────────────────────────────────────────────────
    function stake() external payable;
    function topUp() external payable;
    function requestExit() external;
    function finalizeExit() external;
    function cancelExit() external;

    // ── Governance entry ────────────────────────────────────────────────
    /// @notice Slash `amount` from `relay`'s stake; forward to `recipient`.
    ///         Internally capped at MAX_PUNISHMENT_BPS of current stake.
    ///         Returns the actual slashed amount.
    function slash(
        address relay,
        uint256 amount,
        address recipient,
        uint8 reasonCode
    ) external returns (uint256 slashed);

    // ── Views ───────────────────────────────────────────────────────────
    function isAuthorized(address relay) external view returns (bool);
    function stakeOf(address relay) external view returns (uint256 amount, uint64 joinedAtBlock, uint64 exitRequestedBlock);
    function relayMinStake() external view returns (uint256);
    function exitDelay() external view returns (uint64);
    function totalStaked() external view returns (uint256);
}
