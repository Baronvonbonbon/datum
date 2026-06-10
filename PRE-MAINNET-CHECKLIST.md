# DATUM — Pre-Mainnet Checklist

Active across all alpha lines. Moved to repo root 2026-05-23 (per
PROCESS-FLOW-AUDIT.md §X-LEG-1) so the title no longer claims to be
alpha-4-specific.

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

### U1 — Fix the `msg.sender` wedge in `router.upgradeContract` ✅ FIXED 2026-06-10

**Resolution (option 1, co-authority):** `DatumUpgradable.freeze()` and
`migrate()` now use `onlyGovernanceOrRouter` — the router is accepted as
`msg.sender` alongside the governor, so `upgradeContract`'s atomic
freeze+migrate actually fires. The router only originates these calls from
governor-gated surfaces (`upgradeContract` is onlyGovernor; high-tier
proposals are governor-staged + Council-vetoable + phase ≥ Council), so no
authority widens. `upgradeContract` now emits
`UpgradeHooksFired(name, freezeOk, migrateOk)` instead of silently
discarding the results; the pre-existing two-tx flow
(`scripts/bump-all-paseo.ts`: governor calls freeze/migrate/migrateFundsTo
directly, then rotates) stays valid — the hooks then report `(false,false)`
benignly. Verify gate landed in
`test/governance-router-registry.test.ts` ("atomic freeze+migrate hooks (U1)"):
one-tx upgrade asserts `migrated == true` + `migrationSource == oldAddr` +
state copied; plus two-tx idempotence, non-governor rejection, and
downgrade refusal through the router path.

Original finding (kept for history):

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

### U2 — `_migrate()` overrides on every stateful contract — ✅ LANDED (alpha-5, 2026-06)

Status 2026-06-10: overrides + enumeration scaffolding shipped across the
stateful set (BudgetLedger, PaymentVault incl. `migrateFundsTo` native
sweep via `DatumFundMigratable`, both Stakes, bonds, Campaigns via
`migrateDelegate`/`DatumCampaignsMigrationLogic`, NullifierRegistry,
Reputation, governance clusters, tags, ClickRegistry, …) with per-contract
migration tests (`test/*-migration.test.ts`, `test/upgrade-e2e.test.ts`)
and the live migrator scripts (`bump-all-paseo.ts`,
`migrate-campaigns.ts`, `deploy-batch-upgrade.ts`). See
`alpha-core/MIGRATION-COVERAGE-PLAN.md` for per-contract coverage.

Original scope (kept for history):

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

## Staged contract additions (deploy in the next upgrade)

### Gasless user withdrawal — `DatumPaymentVault.withdrawUserBySig`

Implemented + tested (`alpha-core/test/payment-vault-bysig.test.ts`) but **not yet
deployed**. Lets a new user withdraw without holding gas: the user signs an
EIP-712 `WithdrawAuth` off-chain; any submitter (the relay / an off-chain worker)
broadcasts `withdrawUserBySig`, pays gas, and is reimbursed up to the user-signed
`maxFee` out of the withdrawn balance. Non-custodial — contract enforces signer +
per-user nonce + block deadline, and caps the fee at the balance. Mirrors the
permissionless dual-sig settle path.

- **Adds storage:** `mapping(address => uint256) withdrawNonce` (appended — for an
  in-place rotation this is new empty state; covered by the U2 `_migrate` override
  if/when PaymentVault is migrated, but a fresh redeploy needs nothing).
- **Adds EIP-712 domain** to the vault (`EIP712("DatumPaymentVault","1")`, OZ v5 —
  immutables only, no storage-layout change).
- **Relay side:** `datum-labs/relay` `/withdraw` + `/withdraw-info` endpoints and
  `scripts/sign-withdraw.mjs` are already wired; they report `vault-not-upgraded`
  until this ships.
- **Deploy step:** redeploy `DatumPaymentVault` (or rotate it via the router with
  the U4 coordinated-cluster migration), re-point `BudgetLedger`/`Settlement`
  references as required, then the relay endpoint goes live with no further change.

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

## Secrets / key hygiene (SCRUB BEFORE ANY PUBLIC RELEASE)

Plaintext private keys are hardcoded in committed scripts — e.g.
`alpha-core/scripts/activate-pending.ts:19` (`ALICE_KEY = "0x6eda…"`, the deployer),
plus ~12 other `alpha-core/scripts/*.ts` (setup-demo, setup-testnet, benchmark-paseo,
e2e-token-rewards, verify-*, gas-costs, diag-*, check-testnet, fill-missing-creatives).
These are Paseo **testnet** keys (valueless funds), so the immediate risk is low —
but before open-sourcing or any mainnet work:

- [ ] Move every hardcoded key to a gitignored `.env` (the pattern `alpha-core/.env`
      already uses) and load via `process.env`. No literals in tracked files.
- [ ] `git grep -nE '0x[0-9a-fA-F]{64}'` → confirm zero private-key literals remain
      in tracked sources (filter out legit 32-byte hashes/roots).
- [ ] **Scrub history**, not just HEAD — a committed key is exposed forever in the
      git log. Rotate/abandon any address whose key was ever committed; never reuse
      one on mainnet.
- [ ] Add a pre-commit secret scanner (gitleaks / trufflehog) to CI.
- [ ] Lab note: `../datum-labs/` keeps keys only in gitignored `.env`; keep it that
      way if any of it is published. The lab relay defaults to accepting all
      campaigns (`CAMPAIGN_ALLOWLIST` empty) and binds localhost with no
      HMAC/TLS — a public relay would pay gas for arbitrary posted claims (griefing
      vector); gate it before exposing beyond localhost.
