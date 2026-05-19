// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumSettlementStorage.sol";

/// @title  DatumSettlementLogicB
/// @notice Second half of the Settlement bytecode split (alpha-4 EIP-170
///         phase 8d-2). Will own the shared inner pipeline
///         (`_processBatch` + the publisher-relay helper + the dual-sig
///         entry `processVerifiedBatch`) once Phase 8d-3 moves the body
///         in.
///
/// @dev    LogicB is invoked via DELEGATECALL from either DatumSettlement
///         (for the dual-sig path) or from DatumSettlementLogicA (for the
///         relay paths, which loop through batches then dispatch each
///         batch to LogicB). The shared `DatumSettlementStorage` base
///         guarantees all three contracts have an identical storage
///         layout so every state read/write hits the original caller's
///         slot.
///
/// @dev    LAYOUT INVARIANT: never declare additional state in this
///         contract. New state goes on DatumSettlementStorage.
///
/// @dev    Phase 8d-2 (this commit): empty stub. Deployable so the
///         routing pointer on Settlement (`_logicB`) can be wired and
///         the storage-layout test has a real contract to compare
///         against.
contract DatumSettlementLogicB is DatumSettlementStorage {
    /// @dev DatumUpgradable.version override. See LogicA for the upgrade
    ///      pairing rationale.
    function version() public pure override returns (uint256) { return 1; }
}
