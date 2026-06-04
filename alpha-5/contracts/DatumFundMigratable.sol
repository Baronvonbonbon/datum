// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumPlumbingLockable.sol";

/// @title  DatumFundMigratable
/// @notice Reusable native-DOT fund-sweep for the redeploy-migrate-rewire model.
///         A contract that custodies native DOT inherits this and implements
///         only its own `_migrate` (balance ACCOUNTING copy / enumeration); the
///         actual DOT is swept here, governance-gated + frozen-only + one-shot.
///
///         The successor receives via `acceptMigration` (gated to its recorded
///         `migrationSource`), so it works even when the contract's `receive()`
///         rejects deposits. Sequence: freeze(old) → new.migrate(old) →
///         old.migrateFundsTo(new).
///
/// @dev    No `nonReentrant`: `fundsMigratedOut` is set before the single
///         external call, the call target is the governance-chosen successor,
///         and the function is onlyGovernance + frozen-only. Override
///         `migrateFundsTo` (e.g. for ERC-20 custody) where native sweep
///         doesn't apply.
abstract contract DatumFundMigratable is DatumPlumbingLockable {
    /// @notice One-shot: true once native DOT has been swept to a successor.
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    /// @notice Sweep the entire native balance to a successor during an upgrade
    ///         so it can honour the migrated accounting. Governance-gated,
    ///         frozen-only (a live contract can never be drained), one-shot.
    function migrateFundsTo(address successor) external virtual onlyGovernance {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumFundMigratable(payable(successor)).acceptMigration{value: bal}();
    }

    /// @notice Accept the predecessor's native-DOT inflow during migration.
    ///         Gated to `migrationSource` (set by migrate()) — no open deposits.
    function acceptMigration() external payable virtual {
        require(msg.sender == migrationSource, "not-source");
    }
}
