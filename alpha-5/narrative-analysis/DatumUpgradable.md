# DatumUpgradable

Abstract inheritance base for contracts in the upgrade ladder. ~36
of the 57 production contracts derive from this. Adds versioning,
migration pause, phase-gated locks, and a router-mediated
`onlyGovernance` modifier on top of `DatumOwnable`'s two-step
ownership pattern.

Companion: [`upgrade-ladder-design.md`](./upgrade-ladder-design.md)
covers the registry side (`DatumGovernanceRouter`) and the overall
deploy-time mechanics.

## What this base provides

Three primary surfaces:

1. **Phase-aware authorization** — `onlyGovernance` resolves to
   whatever the router's current `governor` is. Admin (deployer),
   Council, or OpenGov.
2. **Migration pause** — `frozen` flag; `whenNotFrozen` modifier on
   every user-facing mutator. Reads bypass the freeze so a successor
   can pull state.
3. **Lock-once-post-OpenGov** — `whenOpenGovPhase` modifier on
   every cypherpunk lock function. Pre-OpenGov, locks revert
   `not-opengov`. Post-OpenGov, governance can fire them.

Plus versioning (`version() public pure virtual returns (uint256)`)
and the `migrate()` flow.

## Authorization model

The split between `onlyOwner` and `onlyGovernance` is intentional:

- **`onlyOwner`** — used for deploy-time one-shot wiring
  (`setRouter`, lock-once setters that fire before any vote could
  exist). The deployer EOA / Timelock in production.
- **`onlyGovernance`** — used for upgrade / pause / migrate
  authority. Routes through the router's `governor`. Pre-OpenGov
  this is the deployer (Admin phase) or the Council; post-OpenGov
  it's GovernanceV2 / ParameterGovernance / Timelock as wired.

Routine deploy-time wiring stays simple; upgrade authority follows
the phase ladder.

## Storage layout

```
slot 0    _owner            (from DatumOwnable)
slot 1    _pendingOwner     (from DatumOwnable)
slot 2    router            (uint160)
slot 2+20 frozen            (bool)
slot 2+21 migrated          (bool)
slot 3    migrationSource   (address)
slot 4-53 __upgradeGap[50]  (reserved)
slot 54+  child storage
```

Children add their own storage AFTER inheriting this base. They MUST
NOT reorder these fields. The 50-slot `__upgradeGap` lets future
DatumUpgradable additions land in the gap without shifting child
storage. Once that's exhausted, future fields go after child
storage by extending the base (and bumping the slot snapshot for any
storage-layout-sensitive child like the Settlement family).

## Lifecycle of a contract that inherits

```
1. deploy ─────────► version() = 1, frozen = false, migrated = false
2. setRouter(r) ────► one-shot, lock-once
3. (operate) ────────► whenNotFrozen mutators work
4. (upgrade decided) ─► governor calls freeze()
5. frozen = true ────► mutators revert, reads still work
6. new v2 deployed ───► governor calls v2.migrate(thisAddress)
7. v2._migrate(...) ──► state copy
8. v2.migrated = true ─► permanent
```

The registry side (`router.upgradeContract(name, v2Addr)`) updates
the on-chain pointer; this contract's role is to gate access during
the transition.

## `migrate()` invariants

`migrate(oldContract)` requires:

- Not already migrated (`migrated == false`).
- `oldContract != address(0)` and `!= address(this)`.
- `oldContract.version() < this.version()` (no downgrades).
- `oldContract.frozen() == true` (predecessor must be paused).

`migrated` is set BEFORE `_migrate` runs to prevent reentrancy
attacks that try to re-enter migrate during state copying. The
per-contract logic lives in `_migrate(oldContract)` — default is
no-op. Stateful children override to copy storage.

## `_migrate` overrides

Most current overrides ARE no-op (MAINNET-DEFERRED §10.5 marks this
as testnet-acceptable; production decisions per-contract). Patterns:

- **No state to migrate** — token-like contracts where the new
  version starts fresh. No override needed.
- **Small flat state** — copy a handful of variables in `_migrate`.
- **Large state** — paginate. Override `migrate()` entirely so
  `migrated` is only set on the final pagination call.

The paginated-migrate pattern is documented in
`deploy-runbook-paseo.md` §12b.

## Phase modifier semantics

`whenOpenGovPhase`:

- If `router == address(0)` (pre-deploy.ts Stage 5 / standalone
  unit tests): falls through to the existing `onlyOwner` check.
  Lets tests exercise lock-once paths without wiring a router.
- If `router != address(0)`: requires `router.phase() == 2`
  (OpenGov). Reverts `not-opengov` otherwise.

This is the mechanism that lets the system stay malleable through
Admin (phase 0) and Council (phase 1) phases while preserving the
ability to ratify cypherpunk commitments per-contract once OpenGov
takes the helm.

## Events

- **`RouterSet(router)`** — emitted once at `setRouter`.
- **`Frozen()` / `Unfrozen()`** — paired emissions on freeze/unfreeze.
- **`Migrated(from, fromVersion, toVersion)`** — single emission at
  the end of `migrate()`.

## Trust assumptions

- The router is lock-once. Once wired at deploy, no path rotates it.
  A router rotation requires migrating EVERY contract to point at a
  new router — practically infeasible, intentionally.
- The deployer is `onlyOwner` until ownership is transferred via the
  two-step pattern. Production deploys hand off to a Timelock / Safe.
- `onlyGovernance` reads `router.governor()` live, so a governance
  phase transition immediately changes who has authority. Pre-Phase-
  transition writes lock at the predecessor governor's discretion.

## Upgrade

The base contract itself is part of the inheritance chain — upgrading
it requires upgrading every child that inherits it. Storage layout
changes here propagate. The `__upgradeGap` is the soft buffer; once
exhausted, future versions need a careful storage-layout migration
plan.
