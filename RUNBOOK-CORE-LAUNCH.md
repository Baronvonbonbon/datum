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

## Phase 2 — Prove the migration machinery (U3 / U5 / U6) ☐ [TASK]  *(the true upgrade gate)*

U1 (router freeze/migrate wedge) is **fixed**; U2 `_migrate` overrides **landed**.
Remaining before mainnet (see `PRE-MAINNET-CHECKLIST.md` §U3/U5/U6):
- **U5 — golden-path migration harness:** deploy v1 with realistic state →
  coordinated router rotation → re-run the *entire* production test suite against
  v2 → assert zero balance loss / no orphaned state / no permission gap.
- **U3 — gas-paginated migration** for unbounded state (Campaigns, Publishers,
  NullifierRegistry won't fit one mainnet block) + `migrationCursor` view.
- **U6 — indexer/consumer guards** for the partial-migration window (webapp +
  relay refuse "current" reads while `migrated == false`).
**Gate:** U5 harness green end-to-end. **Verify:** CI job runs the v1→v2
migration + re-runs prod suite against v2.

---

## Phase 3 — Wire-format single source of truth + CI drift gate ☐ [TASK]

Root-cause fix for this session's silent drift (relay-bot + reseed-demo went
pre-SLIM while contracts moved to SLIM-#2; only surfaced on a rejected batch).
**Steps:**
1. Pin the claim wire + EIP-712 typehashes in one canonical module; generate /
   assert consumers (relay-bot, extension, web daemon, seed scripts) against it.
2. **Port the live relay-bot to SLIM-#2** (or adopt the template + re-add its
   PoW/endpoints — FP-8 epoch features target deferred modules, safe to drop for
   slim) and align `reseed-demo` settle-sim (slim claims, `firstNonce` dual-sig
   typehash, correct endpoint).
3. CI check: every off-chain consumer's typehashes match the deployed contracts.
**Gate:** an end-to-end gasless-relay settle round-trips on Paseo against
alpha-core. **Verify:** CI drift check green; one live settle on Paseo.

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

## Phase 5 — Custody & governance ☐ [TASK]

Today the deployer EOA is the hot Phase-0 owner.
**Steps:**
1. Stand up a **multisig / Safe** as owner; execute Timelock `acceptOwnership`.
2. Write the **phase-ladder plan**: Admin → Council (`raisePhaseFloor`) → OpenGov,
   and which `lock*()` cypherpunk commitments fire at which phase (relay,
   curators, plumbing) — currently all correctly phase-gated and unfired.
**Gate:** owner = multisig on all upgradables; ladder plan signed off.
**Verify:** `owner()`/`governor()` reads show the multisig; written ladder doc.

---

## Phase 6 — Operational readiness ☐ [TASK]

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
