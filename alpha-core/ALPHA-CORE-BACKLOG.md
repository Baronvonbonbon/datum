# DATUM alpha-core — Consolidated Backlog (Paseo-launch staged)

**Compiled 2026-06-11.** Single source of truth that consolidates the scattered
checklists/backlogs into one item-level list, marks each **done / obsolete /
open**, and stages what's actually required for an **alpha-core launch on Paseo**
(testnet) vs. what is correctly deferred to mainnet.

**Absorbs / supersedes** (**archived 2026-06-11 → `archive/alpha-core-docs/`**;
inline `…-BACKLOG.md §N` / `…-CHECKLIST.md` detail refs below now resolve there):
`PRE-ALPHA-5-BACKLOG.md`, `PRE-MAINNET-CHECKLIST.md` (item-level content),
`V5-VERIFICATION-SNAPSHOT.md` (historical diff-base). Kept as live
references: `RUNBOOK-CORE-LAUNCH.md` (the **mainnet** phase program — this doc is
the item view that feeds it), `DEPLOY-COVERAGE.md`, `MIGRATION-COVERAGE-PLAN.md`,
`OFFCHAIN-SLIM-PORTING.md` (wire-format spec).

**Status legend:** ✅ done · ◐ in progress · ☐ open · ⊘ deferred (out of Paseo
scope) · ⊗ obsolete/superseded.

---

## Current state (verified 2026-06-11)

- **Slim spine LIVE on Paseo** — `deployed-addresses.json`, `deployedAt
  2026-06-10T11:53Z`, network `polkadotTestnet`, 21 contracts (the `DATUM_MVP=1`
  core settlement spine; optional/token/ZK refs are `address(0)`, activatable via
  lock-once setters).
- **Tests: 1674 passing, 1 pending** (was 1671; +3 from the Option-2 router split
  this session). `STATUS.md` is stale at 1579 / "v5" — refresh it (§1.4).
- **Contracts:** 52 `Datum*.sol` + 5 token-plane; no deploy-coverage gaps
  (`DEPLOY-COVERAGE.md`). Settlement under EIP-170 via the two-Logic split.
- **This session's work (committed):** security fixes `8aa0669` (denomination
  M-1/M-2/M-3 + MH-1 U3 freeze-window); Option-2 admin split `1221e26`
  (router `adminGovernor` + Timelock→Council handoff script). See
  `CONTROL-MATRIX-MEMO.md`, `SECURITY-AUDIT-2026-06-11.md`.

---

## §1 — Paseo launch readiness (the staged checklist)

A Paseo (testnet) launch is **achievable now**: the hard engineering gates are
green; what remains is a short operational punch list. Most of the large backlog
(§2) is explicitly *correct to defer on testnet*.

### 1.1 Engineering gates — ✅ DONE

- ✅ **Contracts compile + full suite green** (1674 passing, clean recompile).
- ✅ **Deploy coverage** — every production contract deployed by `deploy.ts` or
  documented-deferred to `deploy-token.ts`; no silent gaps (`DEPLOY-COVERAGE.md`).
- ✅ **Migration machinery proven** (`RUNBOOK-CORE-LAUNCH.md` Phase 2):
  U1 router freeze/migrate wedge · U2 `_migrate` overrides · U3 gas-paginated
  migration (+ MH-1 freeze-window fix this session) · U5 coordinated
  funds-cluster + registry rotation · U6 off-chain partial-migration guard.
- ✅ **Wire-format SSOT + CI drift gate** (Phase 3): `web/src/shared/wireFormat.ts`
  canonical typehashes + `wireFormat.test.ts` drift gate; CI clean-recompile +
  ABI-drift + gitleaks as **required status checks**.
- ✅ **Denomination migration complete** (18-dec wei) incl. this session's
  peripheral fixes (CampaignCreative renewer reward, stake-gate lock ceiling,
  XCM refresh fee).
- ✅ **Secrets gate** — `.gitleaks.toml` + secrets CI job (Phase 6).
- ✅ **Incident runbook + pause drill** — `INCIDENT-RUNBOOK.md` +
  `test/pause-drill.test.ts` (Phase 6).
- ✅ **Admin-control remediation designed + landed** — Option-2 router split;
  Timelock→Council handoff is an operational step (§3).

### 1.2 Operational punch list — ◐ IN PROGRESS (the actual remaining Paseo-launch work)

- ✅ **Fresh slim redeploy** (2026-06-11, `deployedAt 15:56Z`) — `DATUM_MVP=1`
  deploy of the 19-contract spine; `validateConfiguration() == true`; carries the
  session's contract changes (verified on-chain). Prior addresses backed up at
  `deployed-addresses.20260611-pre-core-redeploy.json`.
- ✅ **Seed the testnet.** 6 open campaigns created + activated via the Phase-0
  admin path (`scripts/seed-slim.mjs` — `setup-testnet.ts`/`reseed-demo.mjs` both
  require deferred contracts not in the slim spine; this is the slim-native seed).
  Verified 6/6 Active on-chain.
- ✅ **Register publisher.** Diana registered (`DatumPublishers.registerPublisher`,
  take-rate 5000 bps) + relaySigner → self; verified on-chain. Relay path is now
  settle-ready.

_Step-by-step spin-up procedure: `CORE-DEPLOY-DRESS-REHEARSAL.md` (safety-focused,
back-up→act→verify)._
- ☐ **Port the live relay-bot to SLIM-#2 + restart.** The gitignored
  `relay-bot/relay-bot.mjs` is still pre-SLIM (fat claims). The template
  (`docs/relay-bot-template/`) and the SSOT typehash gate are current; this is the
  operational port + `ADDRESSES` update to the 2026-06-10 deploy + systemd restart
  (`datum-relay@* / datum-cosigner@*`). (`OFFCHAIN-SLIM-PORTING.md` §1–§5.)
- ☐ **Rotate the Pinata credential.** The leaked JWT/API key was removed from
  tracking but remains in git history (`SECRETS-SCRUB-2026-06-10.md`). Operator
  action — rotate before any public-facing demo.
- ☐ **Move ~10 scripts' hardcoded Paseo keys to `.env`** (valueless testnet keys,
  but do it before open-sourcing; never reuse on mainnet).
- ☐ **End-to-end smoke** — a gasless-relay settle round-trips on Paseo against the
  live slim contracts (depends on the relay port + seed above).

### 1.3 Deferred-on-Paseo decisions — ⊘ (explicitly out of slim-launch scope)

- ⊘ **Token plane** (Wrapper/MintAuthority/Vesting/FeeShare/BootstrapPool +
  `DatumTagRegistry`/`DatumZKStake`) — `deploy-token.ts` not invoked in the slim
  launch; wire in post-launch via the proven upgrade ladder.
- ⊘ **ZK claim path** — single-party trusted setup is fine for testnet; the claim
  path is not wired in slim. (MPC is a mainnet gate — §2.)
- ⊘ **People Chain XCM return-leg** — Diana direct path is the testnet fallback;
  do not `lockOracleReporter()`.

### 1.4 Doc hygiene — ☐ OPEN

- ☐ Refresh `STATUS.md` (1579→1674, "v5 full"→"slim spine live 2026-06-10",
  current-phase line).
- ☐ Mark `V5-VERIFICATION-SNAPSHOT.md` as the **v5 historical** record (the live
  diff-base is now the 2026-06-10 slim deploy) and capture a slim-deploy snapshot.

---

## §2 — Mainnet-deferred (NOT Paseo blockers) ⊘

Correct to defer on testnet; **must** run before any Polkadot Hub deploy. Detail
preserved from `PRE-MAINNET-CHECKLIST.md` / `PRE-ALPHA-5-BACKLOG.md` §1; tracked
as phases in `RUNBOOK-CORE-LAUNCH.md` (Phases 1, 4, 5, 7, 8).

**Mock/shim → production:**
- ⊘ Wrapper unwrap XCM: replace `_ahAddressOf` devnet shim with
  `transferToSubstrate`; set `devnetUnwrapShimEnabled=false`; AH-balance
  integration test. (RUNBOOK Phase 4 / L3.)
- ⊘ `AssetHubPrecompileMock` → real Asset Hub precompile.
- ⊘ PeopleChainIdentity oracle reporter → dedicated bridge EOA (not deployer).

**ZK trusted setup → MPC ceremonies:** ⊘ `DatumZKVerifier` (impression) +
`DatumIdentityVerifier` (identity), N-participant MPC. (RUNBOOK Phase 4.)

**deploy.ts production parameters** (PRE-ALPHA-5-BACKLOG §1.2):
- ⊘ deployer/Alice EOAs → Gnosis Safes / hardware wallets.
- ⊘ Lengthen Timelock windows to production values.
- ⊘ `SR_V1_THRESHOLD` 1-of-1 → 3-of-5 external reporters.
- ⊘ Council initial members → real council Safes.
- ⊘ Rotate ActivationBonds / StakeRootV2 / RelayGovernance treasuries off deployer.
- ⊘ Pass real DATUM ERC-20 address to `DatumStakeRootV2` (balance-fraud challenges
  revert E00 until wired).
- ⊘ `mintAuthority.setPauseRegistry(...)` operational wiring before sunset.

**Bytecode / infra / economics:**
- ⊘ Re-confirm Settlement EIP-170 on the mainnet build (`npm run size:mainnet`).
- ⊘ Mainnet gas-price source (dynamic `eth_gasPrice` vs Paseo hardcoded 10¹²).
- ⊘ Native-asset precompile verification on Hub (`verify-native-asset.ts`).
- ⊘ Relay-bot production hardening (multi-publisher, HTTPS, HSM, rate limiting).
- ⊘ Indexer/subgraph (Subsquid/The Graph) before mainnet scale.
- ⊘ Extension per-session/per-campaign approval UX for real DOT.
- ⊘ Publisher-stake bonding-curve + bond-sizing calibration vs real DOT price.

**Audit:**
- ☐ **External professional security audit** (longest pole; can start in parallel —
  RUNBOOK Phase 1). Internal passes found + fixed HIGH bugs; the upgrade-ladder
  retrofit + the Option-2 router authority change (this session) add surface that
  external review should cover. No open Crit/High internally.

---

## §3 — Post-launch / OpenGov lock-downs ☐

Lock-once `lock*()` are `whenOpenGovPhase`-gated — they revert pre-OpenGov, so they
are **OpenGov commitments, not launch steps**. Fire each after operational
validation. Full per-contract list in `PRE-ALPHA-5-BACKLOG.md` §2 (~30 locks across
Tier A plumbing → B curator/policy → C parameter floors → D relay/token/oracle
sunset). Phase-ladder plan drafted (`narrative-analysis/phase-ladder-plan.md`).

**Custody / governance execution (RUNBOOK Phase 5):**
- ◐ **Admin root → Council (Option 2, this session).** Router `adminGovernor`
  split landed (`1221e26`); the operational hand-off is
  `scripts/transfer-timelock-to-council.ts` (setAdminGovernor→Council via Timelock;
  `timelock.transferOwnership(Council)`; Council executes `acceptOwnership`). Run
  when Council membership is final and leaving Phase-0 single-key. See
  `CONTROL-MATRIX-MEMO.md` §8.
- ☐ Stand up the multisig/Safe owner; execute Timelock `acceptOwnership` on every
  upgradable (today owner is pendingOwner-only / deployer EOA effective).
- ☐ Phase ladder: Admin → Council (`raisePhaseFloor`) → OpenGov; fire `lock*()` per
  tier; confirm no EOA holds owner/governor.

**Economic calibration (set non-zero at the right phase):** appeal/claim bonds,
recovery delay, retune cooldowns, guardian damage caps, reputation min-score,
budget/volume caps. (PRE-ALPHA-5-BACKLOG §2/§3.1; closed G-1…G-10 features have
operational calibration tails.)

---

## §4 — Design backlog (non-blocking) ☐

Condensed from `PRE-ALPHA-5-BACKLOG.md` §3. None block Paseo launch or the next
redeploy.

- Progressive-decentralization knobs (ADMISSION whitelist, CAPS, REPUTATION-GATE,
  ORACLE-CB, EMERGENCY-DRAIN).
- Incremental adoption of shipped mixins: `ParameterRetuneGuard` on the other
  governance contracts; G-8 recovery pattern on `DatumTokenRewardVault`; G-6 appeal
  on `DatumTagCurator`.
- Long-horizon: CB8 anti-plutocracy, CB9 cold-key recovery, BootstrapPool Sybil
  hardening, BM-6 viewability dispute, cross-campaign claim batching (~39% gas),
  Kusama staging layer, smoldot light-client.
- In-source deferrals: Publishers blocklist-governance split, TagRegistry VRF
  jurors, GovernanceV2 demote anti-grief grace, StakeRootV2 exclusion-fraud proofs.
- U3 breadth: apply the paginated pattern to other unbounded sets
  (NullifierRegistry uses a predecessor-chain read instead — see
  `SECURITY-AUDIT-2026-06-11.md` I-1/I-2) if they outgrow one block.
- Storage-layout snapshots for every Upgradable (Settlement already done).
- TOKENOMICS write-up of token-plane upgradability/migration before mainnet.

---

## §5 — Source docs: disposition

| Doc | Disposition |
|---|---|
| `PRE-ALPHA-5-BACKLOG.md` | ⊗ superseded → **archived `archive/alpha-core-docs/`** |
| `PRE-MAINNET-CHECKLIST.md` | ⊗ item-level content absorbed into §2/§3 → **archived `archive/alpha-core-docs/`** |
| `V5-VERIFICATION-SNAPSHOT.md` | ⊗ historical v5 diff-base → **archived `archive/alpha-core-docs/`** |
| `STATUS.md` | ◐ stale (1579/v5) → refresh per §1.4 |
| `RUNBOOK-CORE-LAUNCH.md` | ✅ keep — the **mainnet** phase program; this doc is its item view |
| `DEPLOY-COVERAGE.md` | ✅ keep — coverage reference (note: enumerates the v5 full set, not the slim subset) |
| `MIGRATION-COVERAGE-PLAN.md` | ✅ keep — per-contract migration coverage reference |
| `OFFCHAIN-SLIM-PORTING.md` | ✅ keep — wire-format spec; live relay-bot port tracked in §1.2 |
| `SECRETS-SCRUB-2026-06-10.md` | ✅ keep — Pinata rotation tracked in §1.2 |

---

## Paseo-launch go/no-go (rollup)

Launch the alpha-core slim spine on Paseo when:
- ✅ Suite green (1674) · ✅ migration machinery green · ✅ SSOT + CI gates · ✅
  deploy coverage · ✅ slim contracts live (2026-06-10).
- ☐ Testnet seeded · ☐ live relay-bot ported to slim + running · ☐ end-to-end
  gasless settle round-trips · ☐ Pinata rotated · ☐ STATUS/snapshot docs refreshed.

Everything in §2/§3/§4 is **out of Paseo scope** (mainnet / OpenGov / design).

_Maintenance: update on any redeploy, any item state change, or any new
backlog source. Mainnet phases live in `RUNBOOK-CORE-LAUNCH.md`._
