// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";

/// @title  DatumPlumbingLockable
/// @notice Reusable mixin for the cypherpunk "upgradable today, locked
///         tomorrow" posture on a contract's STRUCTURAL REFERENCES (the
///         contract-to-contract wiring: settlement, campaigns, lifecycle,
///         slash, parameter-governance, etc.).
///
///         Structural-ref setters guard on `whenPlumbingUnlocked`: while the
///         umbrella is unlocked, the phased governor (owner = deployer in
///         Admin, Timelock/Council later) may RE-POINT a ref — which is what
///         lets a dependency be upgraded without redeploying every dependent.
///         `lockPlumbing()` is OpenGov-gated and one-way; once fired, every
///         such setter reverts permanently, ratifying the cypherpunk end-state.
///
///         This supersedes the older per-contract unconditional set-once guards
///         (`require(ref == address(0), "already set")` / `revert AlreadySet`)
///         that froze the wiring at DEPLOY time and forced full redeploys to
///         re-point. Contracts that hand-rolled an equivalent `plumbingLocked`
///         (DatumSettlement, DatumClaimValidator, DatumPublishers,
///         DatumRelayStake, DatumBudgetLedger, DatumTagSystem) keep theirs; new
///         and converted contracts inherit this mixin instead.
///
/// @dev    Storage: adds a single `plumbingLocked` bool after the
///         DatumUpgradable base (and its 50-slot gap), before child storage.
///         Children inheriting this instead of DatumUpgradable shift their own
///         layout by one slot — safe for the redeploy-migrate-rewire model
///         (fresh deploy), but NOT for any delegatecall-shared storage stack
///         (e.g. the Settlement Logic split keeps its own `_plumbingLocked`).
abstract contract DatumPlumbingLockable is DatumUpgradable {
    /// @notice Phase-conditional lock over this contract's structural refs.
    bool public plumbingLocked;
    event PlumbingLocked();

    /// @notice Guard for structural-ref setters: re-pointable until locked.
    modifier whenPlumbingUnlocked() {
        require(!plumbingLocked, "locked");
        _;
    }

    /// @notice Cypherpunk end-state lock. OpenGov-gated; once fired, every
    ///         `whenPlumbingUnlocked` setter reverts permanently. `virtual` so
    ///         a contract can override to add a "all critical refs wired before
    ///         lock" guard (then call _lockPlumbing()).
    function lockPlumbing() external virtual onlyOwner whenOpenGovPhase {
        _lockPlumbing();
    }

    /// @dev Shared lock body for overrides. Caller is responsible for the
    ///      onlyOwner + whenOpenGovPhase gating (the external entrypoint).
    function _lockPlumbing() internal {
        require(!plumbingLocked, "already-locked");
        plumbingLocked = true;
        emit PlumbingLocked();
    }
}
