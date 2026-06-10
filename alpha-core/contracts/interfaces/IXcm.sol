// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// @title IXcm
/// @notice Minimal interface to the Polkadot XCM precompile at
///         `0x00000000000000000000000000000000000a0000`.
///
///         The precompile is the EVM-side entry point for sending native
///         XCM messages. It accepts SCALE-encoded `VersionedXcm` byte
///         payloads (see XcmTransactEncoder).
///
/// @dev    Documented at:
///         https://docs.polkadot.com/smart-contracts/precompiles/xcm/
///
///         - `weighMessage`: deterministic local estimate of weight needed
///           to execute the supplied message. Pure-view, free of charge.
///         - `execute`: execute the message LOCALLY (Hub-side). For messages
///           targeting another chain via Transact, the executor parses
///           cross-chain instructions and forwards through HRMP/UMP.
///         - `send`: send a raw XCM to a destination MultiLocation, no
///           local execution. Lower-level. We use `execute` for the
///           bridge because our outbound message includes a local-side
///           `WithdrawAsset` to fund execution from the caller's account.
interface IXcm {
    /// @notice Substrate `Weight` returned from `weighMessage` and consumed
    ///         by `execute`. Two-dimensional: refTime (wall-clock) +
    ///         proofSize (storage-proof bytes).
    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }

    /// @notice Estimate the weight required to execute `message`. Pure-view.
    function weighMessage(bytes calldata message) external view returns (Weight memory);

    /// @notice Execute the supplied SCALE-encoded VersionedXcm message
    ///         locally. `msg.value` funds the WithdrawAsset / PayFees
    ///         portion of the message. `weight` must be at least the
    ///         estimate returned by `weighMessage`.
    function execute(bytes calldata message, Weight calldata weight) external payable;

    /// @notice Lower-level send to a destination MultiLocation. Not used
    ///         by the identity bridge today; declared for completeness.
    function send(bytes calldata destination, bytes calldata message) external payable;
}
