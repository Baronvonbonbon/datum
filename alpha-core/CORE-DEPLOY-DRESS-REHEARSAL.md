# Core Deploy — Dress-Rehearsal Runbook (Paseo)

**Purpose.** A repeatable, **safety-focused** procedure for a full fresh spin-up of
the alpha-core slim spine on Paseo. This is the rehearsal of the exact sequence
that will run on mainnet — except mainnet removes the testnet escape hatch of
*redeploy-and-reseed*, so every step here is built around **back up → act →
independently verify**, and the rehearsal is "clean" only if it completes with
zero manual fixups.

This is the operational detail behind `RUNBOOK-CORE-LAUNCH.md` Phase 7. First
executed end-to-end 2026-06-11 (slim deploy `deployedAt 15:56Z`); the commands and
values below are the real ones from that run.

**Governing principle.** Never reset on-chain state without a restorable backup;
never trust a deploy/seed without an *independent* on-chain read; never run a long
on-chain op without a cheap pre-check that it will succeed.

**Conventions.** Network `polkadotTestnet` → Paseo Hub (chainId 420420417), RPC
`https://eth-rpc-testnet.polkadot.io/`. Deployer = Phase-0 owner + governor
(`0x94CC…62D7` in the rehearsal). Slim spine = the 19 `DATUM_MVP=1` core contracts
(`alpha-core/DEPLOY-COVERAGE.md`). Status: ☐ todo · ◐ in progress · ✅ done.

---

## Phase 0 — Pre-flight (before touching any chain state)

All green BEFORE the deploy. These are cheap and catch the failures that are
expensive on-chain.

- ☐ **Clean working tree at a known commit.** `git status` clean; note the HEAD
  SHA — the deploy must be reproducible from it.
- ☐ **Tests green on a CLEAN recompile.** `rm -rf artifacts cache typechain-types
  && npx hardhat compile && npx hardhat test` → all passing (rehearsal baseline:
  1674 passing, 1 pending). Stale artifacts hide denomination/ABI drift — the
  clean recompile is non-negotiable.
- ☐ **Committed ABIs in sync.** `node web/scripts/sync-abis.mjs` +
  `(cd alpha-core/extension && node scripts/copy-abis.js)` → `git diff` clean.
  *(Lesson 2026-06-11: a contract interface change with stale committed ABIs fails
  the CI ABI-drift gate. Re-sync as part of any contract change, not after.)*
- ☐ **Deploy coverage — no silent gaps.** Run the `comm` check in
  `DEPLOY-COVERAGE.md`; output must be exactly the 9 not-deployed contracts
  (abstract bases + token-deferred + the staged AdvertiserRegistry).
- ☐ **Deployer funded + key loaded.** Read balance + nonce against the live RPC
  (rehearsal: 6,413 PAS, ample). Confirm `DEPLOYER_PRIVATE_KEY` resolves from the
  gitignored `.env`.
- ☐ **Network config sane.** `hardhat.config.ts` `polkadotTestnet` → Paseo RPC;
  `accounts` includes the deployer + seed accounts (`TESTNET_ACCOUNTS`).

---

## Phase 1 — Back up live state (the rollback anchor)

- ☐ **Snapshot the current canonical addresses** before any reset:
  ```sh
  cp deployed-addresses.json deployed-addresses.$(date +%Y%m%d)-pre-core-redeploy.json
  ```
  (Versioned backups are gitignored local rollback artifacts — matches the
  existing `deployed-addresses.v*-*.json` convention.) **Verify** the backup has
  the live key count before proceeding.

---

## Phase 2 — Reset + fresh deploy

- ☐ **Force a fresh deploy.** `deployOrReuse` reuses any address that still has
  code, so a *fresh* deploy requires an empty registry:
  ```sh
  echo '{}' > deployed-addresses.json
  ```
- ☐ **Deploy the slim spine** (long-running; raw-provider + nonce-poll per tx):
  ```sh
  DATUM_MVP=1 npx hardhat run scripts/deploy.ts --network polkadotTestnet
  ```
  **Watch for, in order:** `Settlement layout gate passed (48 slots…)` →
  `DATUM_MVP=1 — SLIM DEPLOY … Core contracts: 19` → each `[n/28]` deploy (deferred
  modules log `SKIP (MVP)`) → `Settlement.validateConfiguration() — all required
  refs wired` → `deployedAt` written. Re-run-safe: if a tx flakes, re-running
  resumes via `deployOrReuse`. The address file is written only after wiring
  validation passes.

---

## Phase 3 — Verify the deploy (independent on-chain reads)

Do not trust the deploy log alone — read the chain.

- ☐ **Config gate.** `Settlement.validateConfiguration() == (true, "")`.
- ☐ **Key count + freshness.** `deployed-addresses.json` has the 19 slim keys; new
  `deployedAt`; `Campaigns.nextCampaignId() == 1` (clean, no carryover state).
- ☐ **New bytecode is actually live** — read a value that only exists in the new
  code (rehearsal proofs):
  - `GovernanceRouter.adminGovernor() == governor() == deployer` (Option-2 split,
    Phase-0 default).
  - `Publishers.MAX_STAKE_GATE_AT_LOCK() == 10**22` (denomination fix).
- ☐ **Validation params** for the seed: `Campaigns.minimumCpmFloor()` (1e15),
  `MINIMUM_BUDGET_WEI()` (1e17), `maxCampaignBudget()` (0 = unbounded).

---

## Phase 4 — Propagate addresses

The deploy auto-syncs the extension copy; the webapp's runtime-fetched copy is
separate and goes stale every redeploy.

- ☐ `alpha-core/extension/deployed-addresses.json` — auto-synced by `deploy.ts`
  (verify it matches canonical).
- ☐ `web/public/deployed-addresses.json` — **manual** `cp` from canonical; verify
  the `settlement` field matches.
- ☐ Commit the canonical + propagated address files (the launch record).

---

## Phase 5 — Seed (slim-native)

`setup-testnet.ts` requires the 28-contract full deploy; `reseed-demo.mjs` needs a
registered publisher + the deferred `campaignCreative`. Neither runs on the slim
spine. Use the slim-native seed:

- ☐ **Pre-check** the params are valid (rate ≥ `minimumCpmFloor`, budget ≥
  `MINIMUM_BUDGET_WEI`) — `seed-slim.mjs` uses 1 PAS budget / 0.5 PAS CPM, both
  clear the live floors.
- ☐ **Seed** N open campaigns (`publisher = address(0)`, no tags/creative/bond),
  activated via the Phase-0 owner path:
  ```sh
  CAMPAIGNS=6 node scripts/seed-slim.mjs
  ```
  Activation = `GovernanceRouter.adminActivateCampaign` (`onlyOwner onlyAdminPhase`
  — works while the deployer is still the effective owner, i.e. before Timelock
  `acceptOwnership`).
- ☐ **Verify** independently: `nextCampaignId == N+1`; each campaign
  `getCampaignStatus == 1 (Active)`. (Rehearsal: 6/6 Active.)

---

## Phase 6 — Publisher onboarding (settle-readiness)

Open campaigns display + accept claims, but a relay-path settle needs a registered
publisher with a relaySigner. Slim-compatible (`whitelistMode=false`,
`stakeGate=0` on the rehearsal deploy):

- ☐ `DatumPublishers.registerPublisher(takeRateBps)` — `takeRateBps ∈ [3000, 8000]`
  (rehearsal: Diana @ 5000).
- ☐ `DatumPublishers.setRelaySigner(signer)` — point at the relay's signing key
  (rehearsal: Diana → self).
- ☐ **Verify** `getPublisher(addr).registered == true` and
  `relaySigner(addr) == signer`.

---

## Phase 7 — Relay + end-to-end smoke (operator infra)

- ☐ **Port the live relay-bot to SLIM-#2** and point `ADDRESSES` at the new deploy;
  restart `datum-relay@*` / `datum-cosigner@*` (gitignored infra;
  `OFFCHAIN-SLIM-PORTING.md` §1–§5).
- ☐ **End-to-end smoke** — a gasless-relay settle round-trips: build a slim claim
  batch → publisher (+advertiser for dual-sig) cosign → `settleClaims` →
  `PaymentVault` credited → `withdrawUser`. This is the gate that proves the spine
  is live, not just deployed.

---

## Rollback

Paseo is redeploy-friendly — recovery is restore-and-redeploy, not surgery:

- **Restore prior addresses:** `cp deployed-addresses.<snapshot>.json
  deployed-addresses.json` → webapp/extension/relay point back at the previous
  deploy. The old contracts are untouched on-chain.
- **Partial deploy failure:** re-run `deploy.ts` (resumes via `deployOrReuse`); the
  address file isn't written until wiring validation passes, so a mid-deploy abort
  leaves the canonical file untouched.
- **Bad seed:** terminate the campaigns (governor path) or just redeploy fresh.

**Mainnet caveat:** none of the above applies once real DOT escrow/stakes are
on-chain. There is no reseed; a botched upgrade or missing `_migrate` override
loses funds. That is the entire reason this rehearsal must pass with zero manual
fixups before Phase 8 (mainnet) — see `RUNBOOK-CORE-LAUNCH.md`.

---

## Go / no-go

Spin-up is clean when:
- ✅ Pre-flight all green (tests, ABIs, coverage, funds).
- ✅ `validateConfiguration() == true`; new bytecode verified on-chain.
- ✅ Addresses propagated (canonical + extension + web/public).
- ✅ Seed Active (N/N); publisher registered + relaySigner set.
- ✅ End-to-end settle round-trips.

## What changes for mainnet (becomes blocking)

These are deferred-correct on Paseo but are hard gates before Phase 8 — full list
in `ALPHA-CORE-BACKLOG.md` §2:
- Deployer/Council/treasury EOAs → Gnosis Safes; Timelock windows → production.
- Custody hand-off executed: Timelock `acceptOwnership` on every upgradable;
  `adminGovernor` → Council (Option 2, `scripts/transfer-timelock-to-council.ts`);
  no EOA holds owner/governor. (`CONTROL-MATRIX-MEMO.md` §8.)
- External audit closed; ZK MPC ceremonies; Wrapper unwrap XCM (real precompile);
  real DATUM ERC-20 wired; EIP-170 re-confirmed on the mainnet build.
- Migration machinery proven against the migrated set (U1/U2/U3/U5/U6 — done) +
  indexer/relay partial-migration guards live (U6 breadth).
