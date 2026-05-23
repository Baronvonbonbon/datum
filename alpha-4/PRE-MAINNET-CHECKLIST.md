# DATUM Alpha-4 — Pre-Mainnet Checklist

Required hardening steps that are correct to defer on testnet but **must** run
before any mainnet (Polkadot Hub) deploy. Each item is gated by a separate
follow-up; the testnet deploy script does not call these.

## Permission lock-downs

### L2 — Relay: lockRelayerOpen
After vetting the production relayer set, call `DatumRelay.setRelayerAuthorized(relayer, true)` for each authorized address, then `DatumRelay.lockRelayerOpen()`. This converts the relay from open-mode (any EOA passing the stateless sig+liveness checks) to a curated set.

Why this matters: at AssuranceLevel 1, `_processBatch` accepts batches where `msg.sender == relayContract`. While Relay's per-batch publisher sig check is the real L1 enforcement, the open-mode relayer set is an unnecessary attack surface — a vetted set narrows the field.

**Verify:** `await relay.relayerOpen()` returns `false`.

### Curator locks
Once Council membership is stable, lock the curator pointers so even Timelock can't reroute policy authority:
- `DatumCouncilBlocklistCurator.lockCouncil()`
- `DatumTagCurator.lockCouncil()`
- `DatumPublishers.lockBlocklistCurator()`
- `DatumCampaigns.lockTagCurator()`

### Phase floor
After the Phase 1 (Council) transition, call `DatumGovernanceRouter.raisePhaseFloor()` — this prevents any future `setGovernor` from regressing back to Phase 0. Repeat after Phase 2 (OpenGov).

## Code paths requiring mainnet-real implementations

### L3 — Wrapper unwrap XCM path
`DatumWrapper._ahAddressOf(bytes32 accountId)` is a devnet-only shim that derives an EVM-shaped address from a 32-byte AccountId for the mock precompile (`token/DatumWrapper.sol:109-111`). On mainnet (real XCM-backed precompile), this must be replaced with an XCM-aware precompile call that accepts the raw AccountId.

**Fix before mainnet:** swap `precompile.transfer(canonicalAssetId, _ahAddressOf(...), amount)` in `unwrap()` for the production precompile's `transferToSubstrate(canonicalAssetId, accountId, amount)` (or equivalent).

**Verify:** integration test that an `unwrap` to a known Asset Hub AccountId produces a balance increase on Asset Hub.

## Upgrade machinery (`migrate` overrides + router wedge)

Discovered during the 2026-05-22/23 alpha-5 v1→v5 redeploy cycle for Parameter
Governance Phase A + B: state migration is a no-op end-to-end on the current
upgrade-ladder. Every router rotation drops on-chain state and forces a
re-seed. That cost is acceptable while the protocol is iterating, but the
following must land before any mainnet flip — once real user funds and
campaigns are on-chain, the redeploy-and-re-seed posture stops being viable.

### U1 — Fix the `msg.sender` wedge in `router.upgradeContract`

`DatumGovernanceRouter.upgradeContract(name, newAddr)` atomically fires:
```solidity
(bool freezeOk, ) = old.call(abi.encodeWithSignature("freeze()"));
(bool migrateOk, ) = newAddr.call(abi.encodeWithSignature("migrate(address)", old));
```

Both calls reach the target with `msg.sender == address(router)`. The
target's `onlyGovernance` modifier checks `msg.sender == router.governor()`
(the *governor*, not the router itself). The two never match, so both calls
revert silently — return values are deliberately discarded. **The advertised
atomic freeze + migrate flow has been a no-op since the router shipped.**

**Fix:** either accept the router as a co-authority on `freeze()` /
`migrate()` (add `msg.sender == address(router)` to the modifier), or split
the upgrade into a two-tx flow where the governor calls `old.freeze()` and
`new.migrate(old)` directly after the router rotation. The first option
preserves atomicity; the second is more explicit. Either way, a unit test
on Hardhat that asserts `migrate()` actually runs is the gate.

**Verify:** add a test that deploys two upgradable mock contracts, calls
`router.upgradeContract`, and asserts the new contract's `migrated == true`
and `migrationSource == oldAddr`.

### U2 — `_migrate()` overrides on every stateful contract

The default `_migrate(oldContract) internal virtual { oldContract; }` does
nothing. After U1 is fixed, each stateful contract needs an override that
copies its state from the predecessor. Required overrides, in rough order
of stake (literal stake) at risk:

- `DatumBudgetLedger` — advertiser DOT escrow per campaign + per action-pot
- `DatumPaymentVault` — user + publisher pull-payment balances
- `DatumPublisherStake` — bonded balances + pending-unstake requests
- `DatumAdvertiserStake` — same shape, advertiser side (CB4)
- `DatumChallengeBonds` — per-campaign creator/challenger bonds
- `DatumActivationBonds` — same, activation-bond pool
- `DatumCampaigns` — campaign registry + per-campaign pots
- `DatumCampaignLifecycle` — campaign state machine (Pending/Active/etc.)
- `DatumGovernanceV2` — open proposals + vote records
- `DatumAdvertiserGovernance` / `DatumPublisherGovernance` — same
- `DatumTagSystem` — per-publisher tag sets + per-campaign required tags
- `DatumClickRegistry` — recorded click sessions (within validity window)
- `DatumNullifierRegistry` — per-user/per-campaign/per-window nullifier set
- `DatumPublisherReputation` — per-publisher acceptance-rate counters
- `DatumZKStake` — staked balances + commitments (when token plane lands)
- `DatumTagRegistry` — bonded tags + open disputes (when token plane lands)

Stateless / wiring-only contracts (`DatumPauseRegistry`, `DatumGovernanceRouter`
itself, `DatumTimelock`, the verifier contracts, the satellites whose state
is fully derived) do not need overrides — their state is constants or
references re-set during the upgrade-wiring step.

### U3 — Gas-paginated migration pattern

Mainnet-scale state (10k+ campaigns, 100k+ publishers, 1M+ users) will not
fit one block's gas. The base `migrate()` sets `migrated = true` *before*
`_migrate()` runs (for reentrancy safety) — so paginated migrations have to
**override `migrate()` entirely**, not just `_migrate()`:

```solidity
function migrate(address oldContract) external override onlyGovernance {
    require(!migrated, "already migrated");
    // ... pre-flight checks ...
    _migrateBatch(oldContract, currentCursor, BATCH_SIZE);
    if (cursorReachedEnd) {
        migrated = true;
        emit Migrated(oldContract, ..., version());
    }
    // Note: do NOT set `migrated` on intermediate batches; the
    // contract is callable but state is incomplete in this window
    // — off-chain consumers MUST gate on `migrated == true`.
}
```

**Critical:** the partial-migration window must be marked explicitly. Add a
`migrationCursor` view function so off-chain indexers / relays / the webapp
can detect the half-state and pause writes through this contract during it.

### U4 — Lock-once downstream refs vs upgrade-friendliness

Several "holds-funds" contracts deliberately lock their canonical
references on first set:

- `DatumBudgetLedger.{setCampaigns, setSettlement, setLifecycle}`
- `DatumPaymentVault.setSettlement`
- `DatumPublisherStake.{setSettlementContract, setSlashContract}`
- `DatumAdvertiserStake.{setSettlementContract, setSlashContract}`
- `DatumChallengeBonds.{setCampaignsContract, setLifecycleContract}`
- `DatumActivationBonds.setCampaignsContract`
- `DatumNullifierRegistry.setSettlement` (via `lockPlumbing`)
- `DatumMintCoordinator.setSettlement` (via `lockPlumbing`)

This is **deliberate rug protection**: a captured owner cannot re-point
`BudgetLedger.campaigns` to an attacker contract that drains escrow.

The downside (which bit alpha-5 v1→v2): a surgical upgrade of one
"upstream" contract (e.g., `DatumCampaigns`) cannot rewire its downstream
locks. The migration must happen as a **coordinated rotation** of the
entire upstream/downstream cluster — Campaigns + Lifecycle + BudgetLedger +
PaymentVault + ChallengeBonds + ActivationBonds — all swapped together
under one governance proposal, with state copied via `_migrate()` per
contract.

**Pre-mainnet decision required:** confirm the lock-once design is what
mainnet wants. The realistic answer is **yes, keep the locks** (rug
protection is the whole point) — and the operational consequence is that
"upgrades" become "coordinated multi-contract rotations". The deploy
script + the migration test harness must reflect that.

### U5 — Migration test harness

A single golden-path test fixture that:

1. Sets up a v1 deployment with realistic state (N campaigns, N publishers,
   stake balances, open proposals, pending withdrawals, etc.).
2. Deploys v2 of every stateful contract above.
3. Runs the coordinated rotation through the router (or the direct path
   after U1).
4. Re-runs the *existing production test suite* against the v2 contracts.
   Every test that passed against v1 must pass against v2.
5. Asserts no balance loss, no orphaned state, no permission gap.

Cost: substantial. But this is the only way to be confident an upgrade
preserves user state before pushing it to mainnet.

### U6 — Indexer / consumer guards during partial migration

Off-chain consumers (webapp pine + RPC, relay-bot, subgraph, explorer,
extension) must handle the partial-migration window between U3 pagination
batches. Patterns:

- Read `migrated` on every contract before reading state; if false, refuse
  to display "current" state.
- Cache the v1 address until v2's `migrated` flips; serve reads from v1
  during the window, accept writes through v2 only when complete.
- For the webapp specifically: surface a "protocol upgrade in progress"
  banner if any router-registered contract returns `migrated == false`
  while `address != currentAddrOf(name)`.

This belongs in the cross-system runbook, not in any one contract.

### U7 — Sequencing

The minimal viable order for getting `migrate` actually working end-to-end:

1. **U1** (router wedge) — required for any other work to even fire.
2. **U2** (overrides) — write + audit overrides for the high-value
   contracts first (BudgetLedger, PaymentVault, both Stakes).
3. **U3** (pagination) — overlay on U2 for contracts with unbounded state
   (Campaigns, Publishers, NullifierRegistry).
4. **U4** decision (coordinated rotation as the upgrade unit) — informs
   the deploy script and runbook.
5. **U5** (test harness) — gate on this passing before any mainnet
   migration.
6. **U6** (indexer guards) — last, since it depends on the storage shape
   stabilising.

## Token plane sunset (§5.5)

When the DATUM parachain native issuance pallet is live:

1. Deploy the parachain pallet as the new issuer.
2. `DatumMintAuthority.stageIssuerTransfer(parachainPalletAddress)` from Timelock.
3. Parachain pallet calls `acceptIssuerRole()` from its own context.
4. **Irrevocable** — after step 3, the EVM-side authority can never reclaim issuance. `issuerLocked` is permanently true.

This is the intended endpoint of the sunset path. Do NOT call it before parachain readiness — there is no rollback.

## House-ad campaign bootstrap

Before enabling `DatumBootstrapPool`:
- Set the house-ad campaign to AssuranceLevel ≥ 1 (publisher cosig required).
- Wire `DatumBootstrapPool.setCampaigns(campaignsAddr)` so the L1 floor check has a backing reader.
- Confirm `bootstrapPool.minHouseAdAssuranceLevel >= 1`.
