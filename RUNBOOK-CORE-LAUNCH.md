# DATUM — Core Launch Runbook

**Goal:** take the alpha-5 MVP slim spine (live on Paseo 2026-06-10) to a
production **core launch** on Polkadot Hub mainnet, as a single coordinated,
trackable program.

**Governing principle:** mainnet removes the testnet escape hatch of
*redeploy-and-reseed*. Once real DOT escrow / stakes / campaigns are on-chain, a
botched upgrade or a missing migration override loses user funds. So every step
below exists to make the things we deferred while reseed was free actually work
and be *proven* before mainnet.

**Status legend:** ☐ not started · ◐ in progress · ☑ done · ⊘ blocked
Each phase maps to a tracked task (ID in brackets). Update both this file and the
task on status change.

**Launch shape decision (locked):** launch the **slim spine** (core settlement),
wire deferred features in post-launch via the upgrade ladder. Smaller audit
surface; most devnet-shim / ZK-MPC work deferred. The only catch — feature
wire-in still depends on migration working (Phase 2), so slim does not let us
skip the upgrade-machinery gate.

---

## Phase 0 — Bump to `alpha-core` ☑ DONE (2026-06-10, `756522b`)

Rename the active line `alpha-5` → `alpha-core` and declare it the core-launch
baseline. Clean `git mv` (preserves history; single source of truth — no
divergent copy, which is the drift that left the relay-bot pre-SLIM).

**Steps**
1. `git mv alpha-5 alpha-core` (tracked files) + move the untracked
   `node_modules` (or `npm ci` fresh in `alpha-core`).
2. Update the ~60 tracked references `alpha-5` → `alpha-core` (paths + strings)
   across `web/`, `relay-bot.example/`, root docs, `sdk/`, `.gitignore`.
3. Rename package `datum-alpha-5` → `datum-alpha-core`; bump `0.5.0` → `0.6.0`
   (core-launch candidate line; mainnet tag will be `v1.0.0`).
4. Update the gitignored live `relay-bot/` path refs (`../alpha-5/…` →
   `../alpha-core/…`) — operational, not committed.
**Gate:** `npx hardhat compile` + full test suite green; `web` vite build +
`extension` webpack build green; `git grep alpha-5` returns only archival/historical
mentions. **Verify:** all three builds pass on the renamed tree.

**Outcome:** rename done (`git mv`, history preserved), `datum-alpha-core@0.6.0`,
all path refs migrated, builds green. The clean recompile the bump forced
**exposed an incomplete 18-dec-wei denomination migration** that stale artifacts
had hidden (the "1659 passing" greens were false). Completed it as part of this
phase: `test/helpers/dot.ts` planck→wei; **two real contract bugs** fixed —
`DatumEmissionEngine`/`MintCoordinator` `dotPaid` wei-normalization (was ~10^8×
over-mint) and `DatumAdvertiserStake.recordBudgetSpent` budget divisor (was 10^8×
inflated bonding curve); stake/bond/quorum ceilings rescaled planck→wei across
AdvertiserStake/PublisherStake/ActivationBonds/GovernanceV2. **Full suite 1659
passing on a real clean recompile.** This makes Phase 3's CI clean-recompile gate
non-negotiable — without it, denomination/ABI drift silently false-greens.

---

## Phase 1 — External security audit ☐ [TASK]  *(longest pole — start in parallel with Phase 2)*

Outside eyes on real-funds surface: the DELEGATECALL Settlement split
(Settlement/LogicA/LogicB shared layout), dual-sig + relay signature paths, and
the upgrade/migrate authority model (`onlyGovernanceOrRouter`, router
`upgradeContract`).
**Steps:** freeze contract surface → engage auditor → triage → fix deltas →
re-audit deltas. **Gate:** no open High/Critical; Mediums dispositioned.
**Verify:** signed-off audit report archived in `alpha-core/narrative-analysis/`.

---

## Phase 2 — Prove the migration machinery (U3 / U5 / U6) ☑ [TASK]  *(the true upgrade gate)*

**Core gates all green: U1 ✓ (router wedge) · U2 ✓ (`_migrate` overrides) · U5 ✓
(coordinated full-cluster rotation) · U3 ✓ (gas-paginated migration) · U6 ✓
(off-chain partial-migration guard + webapp banner).** Remaining items below are
breadth/optional, not gates.

U1 (router freeze/migrate wedge) is **fixed**; U2 `_migrate` overrides **landed**.

**☑ U5 coordinated funds-cluster rotation (2026-06-10, `test/upgrade-u5-cluster.test.ts`,
`6885d45`):** the gap no existing test covered (the 17 per-contract tests +
upgrade-e2e rotate one contract at a time; this rotates the cluster TOGETHER, the
U4 "coordinated rotation as the upgrade unit"). Now covers **all six native-PAS
custodians rotated as one unit** — BudgetLedger, PaymentVault, ChallengeBonds,
ActivationBonds, PublisherStake, AdvertiserStake (freeze all → migrate all →
sweep all) — asserting **cluster-wide native-PAS conservation** (the complete
"no balance loss" gate; sum(v2)==sum(v1)==total), **full per-entity state on every
v2**, **v2 solvent + functional** (user withdrawal + advertiser refund succeed
post-migration), residual-PAS reconciliation, and governance-gating at every step.

**☑ U5 registry tier (2026-06-10, `bf45295`):** coordinated rotation now spans
**both tiers of the U4 cluster** — the 6 fund holders (PAS conservation) *and* the
registry: Campaigns full-state replay via the `migrateDelegate` →
`DatumCampaignsMigrationLogic.importCampaignFull` mechanism (creates a real v1
campaign, freezes it, replays struct+pots+gates into v2) + Lifecycle freeze →
replace → rewire (stateless coordinator — status lives on Campaigns). 1663 passing.

**☑ U3 gas-paginated migration (2026-06-10, `832b8b8`):** the unbounded-state
pattern, implemented on `DatumPublishers` as the template. `DatumUpgradable.migrate()`
is now `virtual`; `DatumPublishers` overrides it to copy ≤ `MIGRATION_BATCH_SIZE`
(50) publishers per call from the frozen predecessor, advance a public
`migrationCursor`, and set `migrated = true` only on the final batch. Test
(`test/upgrade-u3-pagination.test.ts`): 110 publishers → 3 batches; asserts cursor
advances, the **partial window is observable** (`migrated == false` + only the
copied prefix present mid-flight — the U6 gate signal), full-fidelity completion,
re-migrate reverts, source-mismatch + non-governor rejected. (Campaigns already
paginates per-campaign via `migrateDelegate`.)

**Remaining:**
- **U3 breadth:** apply the same paginated pattern to other unbounded sets if/when
  they outgrow one block (NullifierRegistry, the enumerable fund-holders). Pattern
  is now a proven template.
- **☑ U6 (2026-06-10, `db4ff85`):** shared `web/src/lib/migrationGuard.ts`
  primitive (`classifyMigration`/`isMidMigration`/`readMigrationState`/
  `midMigrationContracts`) + 8 vitest cases + `useMidMigration` hook + a
  "protocol upgrade in progress" banner in `Layout`. Correct signal:
  `migrationSource != 0 && !migrated` (genesis contracts are `migrated == false`
  forever). **U6 breadth:** the relay-bot + indexer should import the same
  primitive to pause writes through a mid-migration contract.
- **U5 optional:** re-run the production suite against the migrated set.
**Gate:** coordinated harness green across the full funds/state cluster ☑; U3
pagination green ☑. **Verify:** CI runs both; the clean-recompile gate (Phase 3)
keeps them honest.

---

## Phase 3 — Wire-format single source of truth + CI drift gate ◐ [TASK]

Root-cause fix for this session's silent drift (relay-bot + reseed-demo went
pre-SLIM while contracts moved to SLIM-#2; only surfaced on a rejected batch).

**☑ DONE (2026-06-10, `.github/workflows/ci.yml`): the CI drift gate.** Every
push/PR to main runs a **clean recompile** (`rm -rf artifacts cache
typechain-types` → compile → full suite) so tests can never run against stale
bytecode — the exact false-green that hid the denomination bugs. Plus an
**ABI-drift check**: regenerate the committed extension/web ABIs from fresh
artifacts and fail if any differ (caught + fixed a real drift — the router ABI
was missing `UpgradeHooksFired`). First run green: contracts 4m43s, frontend 1m0s.
*Recommended follow-up:* make the `CI` check a required status check in branch
protection so it blocks merges.

**☑ Wire-format SSOT (2026-06-10, `1a649d3`):** `web/src/shared/wireFormat.ts` is
the canonical EIP-712 typehash + slim-claim source. `web/test/wireFormat.test.ts`
is the **drift gate**: it reads the typehash STRINGS out of the Solidity sources
(DatumRelay / DatumAttestationVerifier / DatumDualSigSettlement) and asserts the
canonical module reconstructs each exactly, AND extracts every off-chain
consumer's EIP-712 type def (relay-bot template, reseed-demo, web daemon) and
asserts they match — **caught + fixed a real drift** (reseed-demo's dual-sig
ClaimBatch was missing `firstNonce`). The web daemon now imports the canonical
types (can't drift). CI frontend job now runs `npm test` (vitest) so the SSOT +
migration-guard gates enforce on every push. (ABI-drift + clean-recompile gates
already in `ci.yml`.)

**Remaining:**
1. **Port the LIVE relay-bot to SLIM-#2** — the gitignored `relay-bot/relay-bot.mjs`
   is still pre-SLIM (fat claims, `/relay/submit`+PoW+FP-8). The template is
   current and the SSOT gate now enforces typehashes; this is the operational
   port + systemd restart (user's infra).
2. **Full `reseed-demo` settle-sim slim-port** — its dual-sig typehash is now
   fixed/gated, but the settle-sim still builds fat claims to `/claim`; the
   seeding path itself works with `SIMULATE=0` (used for the live seed).
**Gate (end-to-end):** a gasless-relay settle round-trips on Paseo against
alpha-core — needs (1)+(2) + the live relay-bot running. SSOT/CI gates ☑.

---

## Phase 4 — Mainnet-real code paths ☐ [TASK]  *(only items in slim-launch scope)*

- **L3 — Wrapper unwrap XCM:** replace the `_ahAddressOf` devnet shim with the
  production XCM precompile (`transferToSubstrate`). *Deferred if the token plane
  is not in the slim launch.*
- **ZK trusted setup:** single-party setup → **multi-party MPC ceremony**.
  *Deferred while the ZK claim path is not wired in slim.*
**Gate:** each in-scope path has a mainnet integration test. **Verify:** documented
per path; out-of-scope paths explicitly marked deferred.

---

## Phase 5 — Custody & governance ◐ [TASK]

**☑ Phase-ladder plan drafted (2026-06-10, `1f160df`,
`alpha-core/narrative-analysis/phase-ladder-plan.md`):** custody model (owner =
Timelock 48h; `router.governor` follows the phase Admin=Safe → Council → OpenGov),
exact transition calls (`setGovernor`→`acceptGovernor`→`raisePhaseFloor`, hard-floored
regression), and the lock-firing schedule — all ~30 `lock*()` are `whenOpenGovPhase`
(Tier A plumbing → B curator/policy → C parameter floors → D relay/token/oracle
sunset), so they're OpenGov commitments, not launch steps. Lock locations verified
against source. **Remaining = operational execution:** deploy the Safe (N-of-M),
execute Timelock `acceptOwnership` on every upgradable (today owner is pendingOwner
only / deployer EOA effective), confirm no EOA holds owner/governor.

Today the deployer EOA is the hot Phase-0 owner.
**Steps:**
1. Stand up a **multisig / Safe** as owner; execute Timelock `acceptOwnership`.
2. Write the **phase-ladder plan**: Admin → Council (`raisePhaseFloor`) → OpenGov,
   and which `lock*()` cypherpunk commitments fire at which phase (relay,
   curators, plumbing) — currently all correctly phase-gated and unfired.
**Gate:** owner = multisig on all upgradables; ladder plan signed off.
**Verify:** `owner()`/`governor()` reads show the multisig; written ladder doc.

---

## Phase 6 — Operational readiness ◐ [TASK]

**☑ Secrets scrub (2026-06-10, `049f4d7`, `SECRETS-SCRUB-2026-06-10.md`):**
- 🔴 **CRITICAL found + removed:** `archive/alpha-2/TESTNET-KEYS.md` (a "NEVER
  COMMIT" file that *was* committed) held the **live Pinata JWT + API key/secret**.
  Removed from tracking + gitignored. **OPERATOR MUST ROTATE** the Pinata
  credential (still in git history).
- 🟠 testnet deployer/benchmark keys hardcoded in ~10 scripts (`0x6eda…` is the
  live deployment owner) — valueless on Paseo, flagged never-reuse-on-mainnet +
  move-to-`.env`.
- **Durable gate:** `.gitleaks.toml` + a `secrets` CI job (gitleaks, working-tree
  scan; 15 testnet keys allowlisted by value so new/real secrets still fail). Ran
  clean; **now a required status check** (3 required: Contracts, Frontend, Secret
  scan). **Remaining operator action: rotate Pinata.**

**Remaining (ops readiness):** monitoring/alerting on `validateConfiguration` +
invariants; pause drills (prove settlement halt via PauseRegistry); incident
runbook (rollback posture under lock-once); move script keys to `.env`.

- Monitoring/alerting on `validateConfiguration()` + key invariants.
- **Pause drills:** prove settlement can be halted via PauseRegistry under attack.
- Incident runbook (who, what, rollback posture given the lock-once model).
- **Secrets scrub:** rotate anything that touched a repo/CI; confirm no real key
  ships in a public artifact (`PRE-MAINNET-CHECKLIST.md` secrets section). The
  `alpha-core/.env` holds plaintext keys today.
**Gate:** pause drill passes; secrets audit clean. **Verify:** drill log + scrub checklist.

---

## Phase 7 — Mainnet rehearsal (fresh Paseo dress run) ☐ [TASK]

Full dress rehearsal on a clean Paseo instance: `DATUM_MVP=1` deploy → register
publishers → seed → run the **U5 migration** against it → exercise the phase
ladder. Proves the end-to-end sequence before real funds.
**Gate:** rehearsal completes with zero manual fixups. **Verify:** rehearsal log.

---

## Phase 8 — Core launch (mainnet) ☐ [TASK]

Mainnet slim deploy → apply Phase-5 custody → monitor → begin the phase ladder →
wire deferred features post-launch via the proven upgrade machinery.
**Gate:** Phases 1–7 complete. **Verify:** `validateConfiguration()` true on
mainnet; tag `v1.0.0`.

---

## Dependency graph

```
Phase 0 (bump) ─┬─► Phase 1 (audit) ──────────────┐
                ├─► Phase 2 (migration) ──┐        │
                └─► Phase 3 (wire/CI) ─────┤        │
                                           ▼        ▼
                    Phase 4 (mainnet paths)·Phase 5 (custody)·Phase 6 (ops)
                                           └────────┬────────┘
                                                    ▼
                                          Phase 7 (rehearsal)
                                                    ▼
                                          Phase 8 (core launch)
```
Phases 1, 2, 3 run in parallel after Phase 0. Phase 7 gates on 1–6. Phase 8 gates on 7.
