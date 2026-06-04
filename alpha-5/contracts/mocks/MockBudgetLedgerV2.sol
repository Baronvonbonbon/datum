// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "../DatumBudgetLedger.sol";

/// @dev Test-only successor exercising the DatumUpgradable migrate() flow
///      against DatumBudgetLedger: bumps version() and inherits the enumerable
///      `_migrate` + `migrateFundsTo`, so the migration test can verify budget
///      accounting + refunds + native DOT are copied from a frozen predecessor.
contract MockBudgetLedgerV2 is DatumBudgetLedger {
    function version() public pure override returns (uint256) { return 2; }
}
