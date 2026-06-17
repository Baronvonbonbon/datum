# DATUM — Incident Response Runbook

Operational procedure for halting, triaging, and recovering from an on-chain
incident. Grounded in the live mechanisms: `DatumPauseRegistry` (halt),
`DatumGovernanceRouter` + the migration machinery (recover), and the phase ladder
(who acts). The halt primitive is proven by `alpha-core/test/pause-drill.test.ts`.

---

## 0. Roles by phase

Who can act depends on the governance phase (`router.phase()`), per
`alpha-core/narrative-analysis/phase-ladder-plan.md`:

| Phase | Fast actor (halt) | Slow actor (fix/upgrade) |
|---|---|---|
| Admin (0) | any **guardian** (1-of-N) | deployer Safe (instant, Phase-0) |
| Council (1) | any **guardian** | `DatumCouncil` (N-of-M vote) |
| OpenGov (2) | any **guardian** | `DatumGovernanceV2` + 48h Timelock |

**Key asymmetry:** the *pause* is always fast (1 guardian, any phase). The *fix*
slows down as decentralization advances — which is exactly why the pause exists:
it buys the time the slow path needs.

---

## 1. Detect

Monitor + alert on:
- `DatumSettlement.validateConfiguration()` → flips to `(false, …)` (a required
  ref unset / mis-wired).
- Settlement reject-rate / reason-code spikes (`ClaimRejected` events), anomalous
  payout volume vs `BudgetLedger` remaining.
- Any router-current contract reporting `migrated == false` while not genesis
  (mid-migration window — see U6 `migrationGuard`).
- Balance invariants: `PaymentVault` + `BudgetLedger` custodied PAS vs accounting.
- Pause state changes (`PauseEngaged` / `PauseApproved`).

---

## 2. Contain — HALT (any guardian, one tx)

Stop the bleeding first; diagnose second. Pausing is reversible only by 2-of-3, so
it is safe to over-pause.

```
# Full stop (all categories):
pauseRegistry.pauseFast()                       # guardian, 1-of-N

# Scoped (preferred — minimise blast radius):
pauseRegistry.pauseFastCategories(CAT_SETTLEMENT)        # = 1  → settle batches revert Paused
pauseRegistry.pauseFastCategories(CAT_CAMPAIGN_CREATION) # = 2
# CAT_GOVERNANCE = 4, CAT_TOKEN_MINT = 8, CAT_ALL = 15
```

Effect: `pausedSettlement()` → true → `DatumSettlement` reverts every batch
(`DatumSettlement.sol:593`). A solo pause is **bounded** (`soloMaxPauseBlocks`
≈ 24h) and **category-scoped** — a lone/compromised guardian cannot freeze the
protocol forever or beyond the affected surface. To hold longer, 2-of-3
`proposeExtendPause`.

**Verify:** `pausedSettlement() == true` (drill test "FAST HALT").

---

## 3. Triage — classify severity

| Sev | Example | Response |
|---|---|---|
| **S1 fund-loss / exploit live** | drain path in settlement/vault/bonds | `pauseFast()` (full) → S1 bridge below |
| **S2 mis-config / wrong refs** | `validateConfiguration() == false`, wrong wiring | scoped pause → re-wire (pre-lock setters) |
| **S3 griefing / abuse** | spam, anomalous rejects | scoped pause if needed → tune params (ParameterGovernance / PoW) |
| **S4 off-chain** | relay/indexer/webapp stale or down | no chain pause; fix off-chain, gate consumers on `migrated`/health |

---

## 4. Remediate (under the lock-once model)

The recovery posture is **redeploy-migrate-rewire**, proven by the Phase-2 harness
(`upgrade-u5-cluster.test.ts`, `upgrade-u3-pagination.test.ts`):

1. **Bad parameter** → governance setter (Phase-appropriate). Pre-OpenGov these
   are owner/Timelock; no redeploy.
2. **Bad/compromised contract** → deploy a fixed v2 and rotate it in via the
   router:
   - `router.upgradeContract(name, v2)` (atomic freeze + migrate, U1) for an
     isolated contract, **or**
   - a **coordinated cluster rotation** for any funds-holder (Campaigns +
     Lifecycle + BudgetLedger + PaymentVault + bonds + stakes together) — freeze
     all → migrate all → `migrateFundsTo` sweep all → rewire. Native PAS is
     conserved cluster-wide (U5). Unbounded sets (Publishers) migrate in batches
     (U3); off-chain consumers gate on `migrated` during the window (U6).
   - **Lock-once refs are the safety net, not an obstacle:** a captured owner
     *cannot* re-point `BudgetLedger.campaigns` etc. at an attacker — the rug
     surface is bounded. Recovery happens through the migration path, which copies
     state into a governance-blessed successor.
3. **Compromised guardian / governor** → guardian rotation (2-of-3
   `proposeGuardianRotation`); governor regression via the 48h-timelocked
   `proposeRegression` → `executeRegression` (cannot fall below `hardFloor`).

**Do NOT** fire any `lock*()` during incident response — they are OpenGov
cypherpunk commitments, irreversible, and orthogonal to recovery.

---

## 5. Re-engage (deliberate, 2-of-3)

Only after the fix is verified on-chain:

```
id = pauseRegistry.proposeCategoryUnpause(CAT_SETTLEMENT)   # guardian A (auto-approves, 1/2)
pauseRegistry.approve(id)                                   # guardian B → 2/2 → executes unpause
```

**Verify:** `pausedSettlement() == false`; run a canary settle; confirm
`validateConfiguration() == true`. (drill test "DELIBERATE RE-ENGAGE".)

---

## 6. Post-incident
- Timeline + root cause; if it was config/drift, confirm the CI gates (clean
  recompile / ABI / wire-format SSOT / gitleaks) would now catch it — add a case
  if not.
- If a key was exposed, rotate + treat as burned (see `SECRETS-SCRUB-2026-06-10.md`).
- Update this runbook with anything the drill didn't anticipate.

---

## S1 bridge (fund-loss, live)
1. `pauseFast()` (full stop) — every guardian, immediately, redundantly.
2. Snapshot balances (`PaymentVault`, `BudgetLedger`, bonds, stakes) for the
   loss-accounting + the v2 `_migrate`.
3. Deploy the fix; coordinated cluster rotation into v2 (§4.2); re-wire.
4. Make affected users whole from the migrated/solvent v2 if applicable.
5. 2-of-3 unpause only after canary verification.

---

## 7. Launch controls (training wheels) + the sunset timeline

Initial-launch safety levers, beyond the guardian pause. **Design principle:**
prefer permissionless / auto-engaging safety over discretionary admin levers,
and **every discretionary lever sunsets as the phase ladder advances** — a
control that never comes off is the failure mode (and the worst MSB posture,
per `CONTROL-MATRIX-MEMO.md` §5/§7).

### 7.1 The control bits

| Control | What it does | Trip / set | Reset | Sunset |
|---|---|---|---|---|
| **Guardian pause** (`DatumPauseRegistry`) | category-scoped fast halt | any guardian, 1-of-N | 2-of-3 `proposeCategoryUnpause`+`approve` | permanent (always available) |
| **Aggregate circuit breaker** (`DatumSettlementRateLimiter`) | protocol-wide per-window view-settlement ceiling; **latches** on breach → all view settles reject | auto on breach; cap via `setGlobalRateLimit` (owner; 0=off) | `resetGlobalBreaker()` — `breakerOperator` or owner | keep; retune via gov |
| **StakeRoot divergence breaker** (`DatumStakeRootV2`) | freezes stake-gated settlement (`isRecent`→false) when the off-chain `watch-stakeRoot-divergence.ts` detects a bad root | `tripDivergenceBreaker()` — `breakerOperator`/owner | `resetDivergenceBreaker()` | keep |
| **No-slash admin terminate** (`GovernanceRouter.adminTerminateCampaign(id,reason)`) | operator kills a spam/unsafe campaign — **full refund, no slash**, reason-coded | deployer, `onlyAdminPhase` | n/a | **auto-sunsets at Phase 1** (`onlyAdminPhase`) |
| **Admin activate / demote** (`adminActivateCampaign` / `adminDemoteCampaign`) | Phase-0 campaign lifecycle shortcuts | deployer, `onlyAdminPhase` | n/a | **auto-sunsets at Phase 1** |
| **Per-campaign budget cap** (`DatumCampaigns`) | bounds custodied escrow per campaign | `setMaxCampaignBudget` (owner; 0=off) | n/a | relax/disable at OpenGov |
| **Relay health gate** (relay) | relay refuses to settle while Settlement is mis-wired / mid-migration | automatic (`/claim`→503) | automatic on recovery | keep |
| **Stakes & bonds** (`*Stake`, `ActivationBonds`, `ChallengeBonds`) | skin-in-the-game; slashing is **adjudicated** (gov/challenge), never unilateral admin | per-contract gov | per-contract | keep; never add `adminSlash` |

**Breaker operators:** the two breaker operator keys (`SettlementRateLimiter.breakerOperator`, `StakeRootV2.breakerOperator`) should be a guardian / ops hot key — fast trip+reset without the 48h Timelock. Owner (Timelock) is the fallback.

### 7.2 Guardian-set hardening (do before launch)

`PauseRegistry` guardians are 3 hardcoded addresses (`deploy.ts`). For launch
they MUST be **distinct hardware/multisig keys, none equal to the deployer** —
otherwise a compromised deployer also holds a pause seat (no defense in depth).
A drift-guard asserts `guardian0 == deployer`; intentionally relax that only when
moving guardians off the deployer.

### 7.3 Sunset timeline (commit publicly)

Time in Phase 0 (Admin) is the highest-exposure window. Commit to dates:

1. **Phase 0 → 1 (Council):** `timelock → router.setGovernor(Council)`. The
   `admin*` campaign shortcuts revert (`onlyAdminPhase`) from here on; campaign
   lifecycle moves to the Council vote + veto window. Also hand the breaker
   operator keys to Council-designated guardians.
2. **Timelock owner → Council:** `scripts/transfer-timelock-to-council.ts`
   (`adminGovernor`=Council + `timelock.transferOwnership(Council)`). Removes the
   deployer as the sole admin root (`CONTROL-MATRIX-MEMO.md` §8).
3. **Phase 1 → 2 (OpenGov):** `router.setGovernor(OpenGov, GovernanceV2)`.
   Upgrade authority (`adminGovernor`) stays Council (admin/campaign split).
4. **Fire `lock*()` per-contract** (OpenGov-gated): ratify the cypherpunk
   commitments — relax the launch caps (budget cap → 0, etc.) deliberately as
   each lock lands.

Verify after each step: `router.phase()`, `router.adminGovernor()`,
`timelock.owner()`, and that `adminActivateCampaign` now reverts.
