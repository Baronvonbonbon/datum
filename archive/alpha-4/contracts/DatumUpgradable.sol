// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumOwnable.sol";

/// @dev Minimal view of DatumGovernanceRouter that DatumUpgradable needs.
///      Kept inline so this base doesn't depend on the full router interface.
interface IDatumRouter_Upgradable {
    function governor() external view returns (address);
    /// @notice Returns the current governance phase as a uint8:
    ///         0 = Admin, 1 = Council, 2 = OpenGov.
    /// @dev    Matches DatumGovernanceRouter.GovernancePhase ordering. uint8
    ///         used rather than the enum so this interface stays minimal.
    function phase() external view returns (uint8);
}

/// @dev Read-side view of a peer DatumUpgradable for migration. Lets the
///      new version validate the predecessor before pulling state.
interface IDatumUpgradable_Migrate {
    function version() external pure returns (uint256);
    function frozen() external view returns (bool);
}

/// @title  DatumUpgradable
/// @notice Abstract base for contracts in the Phase-1 upgrade ladder.
///         Adds versioning, migration-pausability, and a router-mediated
///         `onlyGovernance` modifier on top of DatumOwnable's two-step
///         ownership pattern.
///
/// @dev    Authorization model:
///           - `owner` continues to be the operational controller (Timelock
///             on mainnet, deployer EOA on Paseo). Used for one-shot wiring
///             like `setRouter`.
///           - `onlyGovernance` resolves to the router's current `governor`:
///               * Admin phase  → deployer EOA / Safe
///               * Council phase → DatumCouncil contract
///               * OpenGov phase → DatumGovernanceV2 (which natively delays
///                                 via ParameterGovernance + Timelock).
///
///         This split lets routine deploy-time wiring stay simple (owner)
///         while upgrade/pause/migrate authority follows the phase ladder.
///
/// @dev    Storage layout: `router` + `frozen` + `migrated` + `migrationSource`
///         + a 50-slot `__upgradeGap`. Children should add their own
///         storage AFTER inheriting this base. To remain upgrade-safe,
///         children should NOT reorder these fields and SHOULD reserve
///         their own internal storage gap if they expect future field
///         additions before child fields.
///
/// @dev    Pause semantics here are migration-pause, NOT
///         DatumPauseRegistry's category emergency pause. The two are
///         independent; a contract can pair both if needed.
abstract contract DatumUpgradable is DatumOwnable {

    // ─────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Router holding the phase + governor mapping. Lock-once via
    ///         `setRouter`. Once wired, never changeable — a router rotation
    ///         requires migrating the contract via the registry instead.
    IDatumRouter_Upgradable public router;

    /// @notice Migration pause flag. When true, every function marked
    ///         `whenNotFrozen` reverts. Read calls remain available so a
    ///         successor can `migrate(thisContract)` from the paused state.
    bool public frozen;

    /// @notice Lock-once flag set when `migrate()` completes. Prevents the
    ///         migration step from being re-run accidentally on the same
    ///         contract instance.
    bool public migrated;

    /// @notice Address of the predecessor migrated FROM, if any. Used for
    ///         off-chain audit traceability; not consulted for auth.
    address public migrationSource;

    /// @dev Storage gap for upgrade-safe inheritance. Reserves 50 slots so
    ///      future DatumUpgradable additions don't shift child storage.
    uint256[50] private __upgradeGap;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event RouterSet(address indexed router);
    event Frozen();
    event Unfrozen();
    event Migrated(address indexed from, uint256 fromVersion, uint256 toVersion);

    // ─────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Authorize the router's current governor. Phase-aware.
    modifier onlyGovernance() {
        require(address(router) != address(0), "router-unset");
        require(msg.sender == router.governor(), "E19");
        _;
    }

    /// @notice Block state-mutating calls while the contract is paused for
    ///         migration. Reads bypass this so a successor can pull state.
    modifier whenNotFrozen() {
        require(!frozen, "frozen");
        _;
    }

    /// @notice Restrict lock-once / cypherpunk-commitment functions to the
    ///         OpenGov phase. Pre-OpenGov, locks revert — the system stays
    ///         upgradable through Admin and Council phases. Once OpenGov is
    ///         in charge, OpenGov can choose to fire locks per-contract,
    ///         ratifying the cypherpunk end-state.
    /// @dev    When the router is not yet wired (pre-deploy.ts Stage 5 or in
    ///         standalone unit tests), the modifier defers to the existing
    ///         onlyOwner check on the function. This preserves
    ///         backwards-compatibility for tests while enforcing the phase
    ///         gate once Stage 5 calls setRouter on every contract.
    modifier whenOpenGovPhase() {
        if (address(router) != address(0)) {
            require(router.phase() == 2, "not-opengov");
        }
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Versioning
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Per-contract implementation version. Override per-deployment
    ///         (typically incremented on each upgrade). Successor's
    ///         `version()` MUST be strictly greater than predecessor's for
    ///         `migrate()` to accept the transfer.
    function version() public pure virtual returns (uint256) {
        return 1;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    /// @notice One-shot wire of the router. Owner-only (deployer / Timelock)
    ///         since this fires at deploy time before governance has any
    ///         say. Cannot be changed once set.
    function setRouter(address r) external onlyOwner {
        require(address(router) == address(0), "router-set");
        require(r != address(0), "E00");
        router = IDatumRouter_Upgradable(r);
        emit RouterSet(r);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pause / unpause (governance)
    // ─────────────────────────────────────────────────────────────────────

    function freeze() external onlyGovernance {
        require(!frozen, "already frozen");
        frozen = true;
        emit Frozen();
    }

    function unfreeze() external onlyGovernance {
        require(frozen, "not frozen");
        frozen = false;
        emit Unfrozen();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Migration
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Pull state from a paused predecessor. Per-contract logic
    ///         lives in `_migrate`. Lock-once: a single contract instance
    ///         can be the migration target at most once.
    /// @dev    Authorization: governance (router's current governor). This
    ///         is the same authority that upgrades the registry pointer,
    ///         so the upgrade + migrate flow is consistent.
    function migrate(address oldContract) external onlyGovernance {
        require(!migrated, "already migrated");
        require(oldContract != address(0), "E00");
        require(oldContract != address(this), "E18");

        uint256 fromVersion = IDatumUpgradable_Migrate(oldContract).version();
        require(fromVersion < version(), "downgrade");
        require(IDatumUpgradable_Migrate(oldContract).frozen(), "old-not-frozen");

        // Set migrated BEFORE _migrate runs to prevent reentrancy attacks
        // that try to re-enter migrate during state copying.
        migrated = true;
        migrationSource = oldContract;

        _migrate(oldContract);

        emit Migrated(oldContract, fromVersion, version());
    }

    /// @dev Per-contract migration implementation. Default is no-op for
    ///      stateless contracts. Override in stateful contracts to copy
    ///      storage from `oldContract`. Be paranoid about gas — paginate
    ///      large state migrations across multiple calls if needed
    ///      (set `migrated` only at the end, in the final pagination
    ///      call, by overriding `migrate()` entirely if necessary).
    function _migrate(address oldContract) internal virtual {
        oldContract; // silence unused-var warning
    }
}
