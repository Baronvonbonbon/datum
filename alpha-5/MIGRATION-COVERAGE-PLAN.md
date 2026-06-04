# Protocol-wide upgrade/migration coverage plan

> ## ⚠️ FOLLOW-UP: DatumCampaigns EIP-170 carve-out (blocks full Campaigns migration)
> DatumCampaigns is at the EIP-170 ceiling — adding the migration write hooks
> (`migrateImportCampaign` / `migrateBumpNextId` / `getCampaignStruct`) pushed it
> to **24442 B / 24576 (only 134 B headroom)**. Consequence: the migrator
> (`scripts/migrate-campaigns.ts` + the in-contract hooks) carries only the core
> `Campaign` struct + 3 settlement gates (assurance / minStake / identityLevel);
> the **full per-campaign side-state does NOT fit and is NOT migrated** — pots
> array, allowlist snapshot, tags, requiredCategory, userEventCap/window,
> minUserSettledHistory. Budgets migrate separately via DatumBudgetLedger.
>
> **Action:** slim DatumCampaigns via the carve-out remerge (see
> `[[project_eip170_remerge_plan]]`) so the side-state import code fits, THEN
> extend `migrateImportCampaign` to cover it and drop the "re-set post-migration"
> caveat from the script. Until then, advertisers must re-apply those optional
> per-campaign gates after a Campaigns upgrade. This is on the critical path for
> a *complete* Campaigns migration and should be sequenced before / alongside the
> remaining governance + stake-root migrations.

Goal: **seamlessly upgrade any contract and carry over all logic + state**, as
modularly as possible. Two independent axes per contract:

- **Axis A — phase-conditional structural refs.** Every contract-to-contract
  reference (settlement, campaigns, lifecycle, slash, parameterGovernance,
  mintAuthority, …) must be GOVERNANCE-re-pointable until OpenGov fires
  `lockPlumbing()`, so upgrading a dependency never forces a dependent redeploy.
  Canonical pattern: inherit **`DatumPlumbingLockable`** → guard setters with
  `whenPlumbingUnlocked`. (Decision 2026-06: ALL refs incl. PG/slash/mint go
  phase-conditional; the OpenGov lock + phase ladder is the backstop.)
- **Axis B — `_migrate` state carry-over.** Every stateful contract overrides
  `_migrate(old)` to copy its state from a frozen predecessor, plus (if it holds
  value) a governance/frozen/one-shot `migrateFundsTo` sweep. Mappings aren't
  iterable, so each adds key enumeration. Fund contracts whose `receive()`
  rejects use a `migrationSource`-gated `acceptMigration()`.

## Modular building blocks

- `DatumUpgradable` — router/frozen/migrated/migrationSource/version/migrate→`_migrate`.
- `DatumPlumbingLockable is DatumUpgradable` — `plumbingLocked` + `whenPlumbingUnlocked` + `lockPlumbing` (virtual; override for "wired-before-lock" guards via `_lockPlumbing`). **[shipped]**
- TODO `DatumFundMigratable is DatumPlumbingLockable` — `fundsMigratedOut` + `migrateFundsTo` (native) + `acceptMigration`. Hoist the 9 hand-rolled native sweeps onto it.
- TODO enumeration helper — adopt OZ `EnumerableSet.AddressSet/UintSet` to replace the hand-rolled `address[] + mapping + _track` per contract.

## Status inventory

### Axis A — already phase-conditional (correct; converge onto mixin = cleanup)
ClaimValidator ✅conv, RelayStake ✅conv, BudgetLedger ✅conv, Settlement (`_plumbingLocked` in shared storage — stays), Publishers (granular locks — keep), TagSystem, CampaignAllowlist, ClickRegistry, NullifierRegistry, Reports, CampaignCreative, SettlementRateLimiter, StakeRootV2, PublisherReputation, Relay, DualSigSettlement, RelayGovernance, GovernanceRouter (own phase source).

### Axis A — NEEDS conversion (unconditional set-once → phase-conditional)
| Contract | Refs to convert |
|---|---|
| DatumPaymentVault | setSettlement ✅done |
| DatumSettlement | configure + 14 set* ✅done |
| DatumBudgetLedger | campaigns/settlement/lifecycle ✅done |
| DatumEmissionEngine | settlement |
| DatumTokenRewardVault | settlement |
| DatumPublisherStake | settlementContract, slashContract |
| DatumAdvertiserStake | settlementContract, slashContract, parameterGovernance |
| DatumChallengeBonds | campaignsContract, campaignAllowlist, lifecycleContract, governanceContract |
| DatumActivationBonds | campaignsContract, parameterGovernance |
| DatumPublisherGovernance | publisherStake, challengeBonds, pauseRegistry, councilArbiter |
| DatumAdvertiserGovernance | parameterGovernance, advertiserStake, councilArbiter |
| DatumMintCoordinator | parameterGovernance, mintAuthority, emissionEngine (has umbrella; setters still AlreadySet) |
| DatumPowEngine | parameterGovernance (has umbrella; PG setter AlreadySet) |
| DatumCampaignLifecycle | parameterGovernance (has umbrella; PG setter "already set") |
| DatumGovernanceV2 | parameterGovernance, lifecycle, campaigns, activationBonds |
| DatumCampaigns | parameterGovernance, publishers, challengeBonds, activationBonds, allowlist, tagSystem, advertiserStake |
| DatumPeopleChainXcmBridge | campaignsContract |

### Axis B — `_migrate` shipped
PaymentVault ✅, AdvertiserRegistry ✅, BudgetLedger ✅, PublisherStake ✅, AdvertiserStake ✅, RelayStake ✅, ZKStake ✅, ChallengeBonds ✅, ActivationBonds ✅, TokenRewardVault ✅, NullifierRegistry ✅ (predecessor-chain), ClickRegistry ✅ (predecessor-chain), **PublisherReputation ✅ (predecessor-chain)**, **MintCoordinator ✅ + PowEngine ✅ (config-copy)**, **Publishers ✅ (registry enumeration)**, **Campaigns ✅ (core struct + gates via gated hooks + off-chain `scripts/migrate-campaigns.ts`; EIP-170 ceiling blocks full side-state → needs carve-out remerge first)**. Native sweeps converged onto **`DatumFundMigratable`** ✅.

Also shipped: **CampaignAllowlist ✅ (enumeration-copy)**, **PeopleChainXcmBridge ✅ (escrow copy + DatumFundMigratable sweep)**.

Also shipped: **PeopleChainIdentity ✅**, **CampaignCreative ✅ (escrow sweep)**.

Also shipped: **StakeRoot ✅, StakeRootV2 ✅, BondedIdentityReporter ✅** (reporter stakes + payouts + roots/commitments via `_queuePayout` enumeration + native sweep; in-flight proposals/attestations drained pre-migration).

Also shipped: **all 6 governances ✅** (RelayGov/Publisher/Advertiser + GovernanceV2/ParameterGovernance/Council — full in-flight vote-state migration: per-proposal voter enumeration + Proposal/Vote copy + payouts + native sweep; conviction locks can't drain so the predecessor is fully retired. Council members reconstructed at deploy).

### Axis-B — `_migrate` still TODO (last group)
TagRegistry / TagSystem (jurors + disputes + staked funds — same reporter-stake + in-flight-challenge shape as the StakeRoot cluster).

### Axis B — `_migrate` NEEDED (stateful)
- **Security-critical (replay):** NullifierRegistry (nullifiers), ClickRegistry (sessions).
- **Core registration (large state):** Campaigns (all campaigns + per-campaign config), Publishers (registrations/stake/relaySigner/profileHash), TagRegistry (commit/reveal tags), TagSystem, CampaignAllowlist, CampaignCreative.
- **Governance in-flight:** GovernanceV2 (votes/conviction locks), Council, ParameterGovernance, RelayGovernance, PublisherGovernance, AdvertiserGovernance.
- **Identity caches:** PeopleChainIdentity, BondedIdentityReporter.
- **Roots/scores:** StakeRoot, StakeRootV2, PublisherReputation.
- **Config-only (light `_migrate` or skip):** MintCoordinator, EmissionEngine, PowEngine (per-campaign PoW config), PeopleChainXcmBridge, SettlementRateLimiter (ephemeral windows — likely skip).

### Axis B — N/A (stateless / verifier / router)
ZKVerifier, AttestationVerifier, IdentityVerifier, DualSigSettlement, Relay, Timelock, GovernanceRouter.

## Execution order (committed batches)
1. ✅ Foundation: mixin + converge ClaimValidator/RelayStake/BudgetLedger.
2. Axis-A sweep, leaf dependents: EmissionEngine, TokenRewardVault, PublisherStake, AdvertiserStake, ChallengeBonds, ActivationBonds, PublisherGovernance, AdvertiserGovernance, MintCoordinator, PowEngine, PeopleChainXcmBridge, CampaignLifecycle. (Fix set-once tests.)
3. Axis-A sweep, central hubs: GovernanceV2, Campaigns. (Highest test-fix surface.)
4. `DatumFundMigratable` mixin + hoist the 9 native sweeps.
5. Axis-B `_migrate`: NullifierRegistry + ClickRegistry (replay) → Publishers + Campaigns → governances → identity/roots → config-light.
6. Per batch: MockXV2 + migration test (enumerate → migrate → [sweep] → solvency), full-suite green, commit.

## Migration strategy by state shape (modularity)
- **Bounded enumerable state** (balances, stakes, bonds, registrations): copy via
  key enumeration + `_migrate` (the shipped pattern). Paginate if large.
- **Append-only replay sets with unbounded cardinality** (NullifierRegistry
  `_used`, ClickRegistry `_sessions`): **DO NOT copy** — use a **predecessor
  chain**. `migrate()` already records `migrationSource`; the successor's
  read/consume path returns `local || (migrationSource != 0 &&
  IPredecessor(migrationSource).isUsed(...))`. O(1) migration, no enumeration,
  gas-cheap; cost is one staticcall per local miss. Chain depth grows by 1 per
  upgrade (rare) — acceptable. This is the canonical pattern for replay stores.
- **Config-only** (rates, curves, windows): copy the scalars in `_migrate`; no
  enumeration.
- **In-flight governance** (open votes/proposals): copy active proposals via a
  proposal-id enumeration; settled history can be left behind (event-sourced).

## Risk notes
- Many tests assert `revertedWith("already set")` / `AlreadySet` on converted setters — each conversion breaks + must update those to phase-conditional semantics (second set succeeds; reverts only after lockPlumbing@OpenGov).
- Converting onto the mixin shifts child storage by one slot — fine for redeploy-migrate-rewire (fresh deploy), NEVER for the Settlement Logic delegatecall stack (keeps its own `_plumbingLocked`).
- Campaigns/Publishers `_migrate` enumeration may exceed single-tx gas at scale → paginate (override `migrate()`).
