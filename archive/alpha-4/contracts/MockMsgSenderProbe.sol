// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  MockMsgSenderProbe
/// @notice Diagnostic mock used by test/settlement-msgsender.test.ts
///         (Phase 8d hedge #2) to assert that DELEGATECALL through the
///         Settlement -> LogicA -> LogicB chain executes in Settlement's
///         storage / address context, not LogicA's or LogicB's.
///
/// @dev    Wire this contract as Settlement's `paymentVault` slot. Run a
///         successful settlement batch. The probe's `lastCaller`
///         records the `msg.sender` it observed on
///         `creditSettlement` -- which MUST be Settlement's address.
///         If any of the DELEGATECALL hops in the chain were actually
///         CALL hops (i.e., a wiring regression broke the pattern),
///         lastCaller would be LogicA's or LogicB's address instead.
contract MockMsgSenderProbe {
    address public lastCaller;
    uint256 public callCount;
    uint256 public lastTotal;
    address public lastPublisher;
    address public lastUser;

    /// @notice IDatumPaymentVault.creditSettlement shape. Settlement
    ///         calls this once per batch via the LogicB inner loop.
    function creditSettlement(
        address publisher,
        uint256 publisherPayment,
        address user,
        uint256 userPayment,
        uint256 protocolFee
    ) external {
        lastCaller = msg.sender;
        callCount += 1;
        lastTotal = publisherPayment + userPayment + protocolFee;
        lastPublisher = publisher;
        lastUser = user;
    }

    /// @notice IDatumPaymentVault.setSettlement stub -- Settlement's
    ///         configure() doesn't call this, but PaymentVault normally
    ///         has it for the reverse-wiring; declared no-op here so
    ///         test setup that mirrors the standard PaymentVault wiring
    ///         doesn't revert.
    function setSettlement(address) external {}

    receive() external payable {}
}
