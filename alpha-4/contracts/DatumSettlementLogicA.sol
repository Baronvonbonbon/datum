// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumSettlementStorage.sol";

/// @title  DatumSettlementLogicA
/// @notice First half of the Settlement bytecode split (alpha-4 EIP-170
///         phase 8d-2). Will own the relay-side entry points
///         (settleClaims, settleClaimsMulti) plus their per-batch auth
///         checks once Phase 8d-4 moves the bodies in.
///
/// @dev    LogicA is only ever invoked via DELEGATECALL from DatumSettlement
///         — never called directly. The shared `DatumSettlementStorage`
///         base guarantees its storage layout matches Settlement's exactly
///         so every SLOAD / SSTORE hits the caller (Settlement) slot.
///
/// @dev    LAYOUT INVARIANT: never declare additional state in this
///         contract. New state goes on DatumSettlementStorage. The
///         storage-layout snapshot test (added in phase 8d-5) compiles
///         this contract alongside DatumSettlement + LogicB and asserts
///         identical layouts.
///
/// @dev    Phase 8d-2 (this commit): empty stub. Deployable so the
///         routing pointer on Settlement (`_logicA`) can be wired and
///         the storage-layout test gets a real contract to compare
///         against.
contract DatumSettlementLogicA is DatumSettlementStorage {
    /// @dev DatumUpgradable.version override. LogicA versions independently
    ///      of Settlement and LogicB — a sub-system upgrade rotates Logic
    ///      pointers while leaving Settlement's slot otherwise stable.
    function version() public pure override returns (uint256) { return 1; }
}
