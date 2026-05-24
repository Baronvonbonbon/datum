# Session Log — 2026-05-23

Single-day arc covering parameter governance Phase A + B, the
advertiser fraud track deploy, the RPC opt-in story on both surfaces,
the process-flow audit, and the three quick legacy cleanups.

This document is the **handoff record** — it indexes into the
artifact docs created during the session and surfaces the open work
that wasn't taken on yet. Read this first when picking the project
back up.

## Session deliverables (in commit order)

| Commit | Title | Surface |
|---|---|---|
| `ea7468d` | Parameter governance Phase A source: tunable floors + timeouts with lock-once | Contracts (DatumCampaigns v2, DatumCampaignLifecycle v2) + tests |
| `0cae0c9` | Deploy Phase A on Paseo (alpha-5 v2 → v3) | Paseo + webapp networks.ts + STATUS |
| `360f807` | Phase A PG whitelist: alpha-5 v3 redeploy + deploy.ts patch | Paseo + deploy.ts hardening |
| `1c47af5` | Parameter governance Phase B source: 5 contracts, 22 setters | Contracts (ActivationBonds, GovernanceV2, MintCoordinator, AdvertiserStake, AdvertiserGovernance) + tests |
| `158b745` | Deploy Phase B on Paseo (alpha-5 v3 → v4) | Paseo + 20 PG-tunable parameters exercised |
| `afb5682` | alpha-5 v5: deploy advertiser fraud track + interest commitments + tag curator | Paseo + 4 new contracts deployed end-to-end |
| `7a1ffb7` | alpha-5 v5 hardening: verification snapshot + deploy-coverage + walkthrough | Doc-only — V5-VERIFICATION-SNAPSHOT, DEPLOY-COVERAGE, V5-WALKTHROUGH-CHECKLIST |
| `ccd2da1` | Webapp: one-shot RPC opt-in on EnableRpcCta | Webapp (cypherpunk RPC posture) |
| `3e07a4e` | Extension RPC refactor: audit + plan | Doc-only — alpha-5/extension/RPC-REFACTOR-AUDIT |
| `f618b89` | Extension: rpcEnabled toggle + one-shot history refresh | Extension settings + popup |
| `634fb79` | PROCESS-FLOW-AUDIT: per-role flow walk + legacy + gap findings | Doc-only — top-level PROCESS-FLOW-AUDIT |
| `cf739df` | Audit cleanups: admin → protocol redirects, phase dedupe, checklist move | Webapp routes + doc reorganization |

**12 commits.** All pushed to `main`.

## Current system state

### On-chain (Paseo Hub, Chain ID 420420417)

Alpha-5 **v5** deployed 2026-05-23T12:23:32Z. Snapshot of the
visible state, addresses, and PG whitelist coverage:
**`alpha-5/V5-VERIFICATION-SNAPSHOT.md`**.

Highlights:
- 34 production contracts + 2 Logic delegates for Settlement
- DatumCampaigns + DatumCampaignLifecycle + DatumActivationBonds +
  DatumGovernanceV2 + DatumMintCoordinator all at **version 2**
  with `parameterGovernance` wired
- DatumAdvertiserStake + DatumAdvertiserGovernance deployed and
  PG-routable for the first time (v5)
- ParameterGovernance: **13 targets × 33 routable selectors**;
  whitelist self-owned and `whitelistLocked = false` (lock-once
  deferred to OpenGov Phase 2)
- All Phase A `lockX()` flags = false (cypherpunk lock deferred to
  Phase 2)

### Deploy coverage

Every `Datum*.sol` contract is either deployed by `scripts/deploy.ts`,
deferred to `deploy-token.ts` with documented reason, or is an
abstract base / storage helper. **Zero silent gaps.** Manifest:
**`alpha-5/DEPLOY-COVERAGE.md`**.

### Parameter governance — what's tunable today

Every entry below is retunable via two paths: owner/Timelock (48h
delay) or ParameterGovernance bicameral (faster). Bounds enforced in
each setter; `lockX()` for the cypherpunk end-state is gated on
OpenGov.

| Contract | Setter | Bounds |
|---|---|---|
| DatumCampaigns | `setMinimumCpmFloor` | `[1, 10 DOT/1000imps]` |
| DatumCampaigns | `setPendingTimeoutBlocks` | `[100, 5_256_000]` |
| DatumCampaignLifecycle | `setInactivityTimeoutBlocks` | `[14_400, 5_256_000]` (1day–1yr; live read = retroactive) |
| DatumActivationBonds | `setMinBond` | `[0, 10^16]` |
| DatumActivationBonds | `setTimelockBlocks` | `[1, MAX_TIMELOCK_BLOCKS]` |
| DatumActivationBonds | `setPunishmentBps` | `winner + treasury ≤ MAX_PUNISHMENT_BPS` |
| DatumActivationBonds | `setMuteMinBond` | `[0, 10^16]` |
| DatumActivationBonds | `setMuteMaxBlocks` | `[1, MAX_TIMELOCK_BLOCKS]` |
| DatumGovernanceV2 | `setQuorumWeighted` | `[0, 10^17]` |
| DatumGovernanceV2 | `setSlashBps` | `[0, 9999]` |
| DatumGovernanceV2 | `setTerminationQuorum` | `[0, 10^17]` |
| DatumGovernanceV2 | `setGraceParams` | `maxGrace ≥ baseGrace` |
| DatumGovernanceV2 | `setConvictionCurve` | `(a≠0 OR b≠0), maxWeight ≤ 1000` |
| DatumGovernanceV2 | `setConvictionLockups` | each `≤ MAX_LOCKUP_BLOCKS` |
| DatumGovernanceV2 | `setCommitRevealPhases` | each `(0, MAX_PHASE_BLOCKS]` |
| DatumMintCoordinator | `setMintRate` | `[0, MAX_MINT_RATE]` |
| DatumMintCoordinator | `setDustMintThreshold` | `≤ 1 DATUM` |
| DatumMintCoordinator | `setDatumRewardSplit` | sum `== 10000` |
| DatumAdvertiserStake | `setParams` | base ≤ 10^16, perDOTSpent ≤ 10^12, delay ≤ 1yr |
| DatumAdvertiserStake | `setMaxRequiredStake` | `(0, 10^17]` |
| DatumAdvertiserStake | `setMaxSlashBpsPerCall` | `(0, 10000]` |
| DatumAdvertiserGovernance | `setParams` | `slashBps ≤ 10000` |
| DatumAdvertiserGovernance | `setConvictionCurve` | same shape as V2 |
| DatumAdvertiserGovernance | `setConvictionLockups` | each `≤ MAX_LOCKUP_BLOCKS` |
| DatumAdvertiserGovernance | `setPublisherClaimBond` | unbounded (governance-discretion) |
| DatumPublisherStake | `setParams`, `setMaxRequiredStake` | pre-existing |
| DatumPublisherGovernance | `setParams`, `setProposeBond` | pre-existing |
| DatumEmissionEngine | `setAdjustmentPeriod` | pre-existing |
| DatumSettlement | `setPowDifficultyCurve` | pre-existing |
| DatumClaimValidator | `setMaxClaimEvents` | pre-existing |
| DatumParameterGovernance | `setParams` | self-governance |

**Verified end-to-end** via `scripts/exercise-governable-params.ts`
— 10/10 governable parameters round-tripped on Paseo (up → down →
restore).

### Webapp

Pointed at alpha-5 v5 addresses. Per-page sanity-check walkthrough:
**`web/V5-WALKTHROUGH-CHECKLIST.md`**.

Key changes from earlier in the session:
- `EnableRpcCta` gains a "Pull once via RPC" button (one-shot opt-in,
  auto-disables on fetch completion). Wired into `/me/history`.
- 13 `/admin/*` routes converted to `<Navigate>` redirects to
  `/protocol/*`.
- 4 previously /admin-only pages (RateLimiter, Reputation,
  PublisherGovernance, NullifierRegistry) promoted to `/protocol/*`.
- `/governance/phase` deduped → redirect to `/phase-ladder`.

### Extension

`alpha-5/extension/` rpcEnabled refactor done end-to-end. Audit +
plan: **`alpha-5/extension/RPC-REFACTOR-AUDIT.md`**.

Key changes:
- New `rpcEnabled` setting (default false on fresh installs,
  migrated to true on upgrade so existing behaviour continues).
- `usePine` default flipped to true on fresh installs (legacy users
  keep false unless they explicitly opt in).
- `getReadProvider()` now accepts `{ rpcAllowed }` option; throws
  "rpc-disabled" when pine isn't ready and RPC isn't allowed.
- All background read paths (campaignPoller, timelockMonitor,
  auto-sweep, signed-batch expiry, auto-submit settle provider)
  thread `rpcAllowed: settings.rpcEnabled ?? false` through.
- New message handler `EARNINGS_REFRESH_ONESHOT`: temporarily
  enables RPC for an earnings backfill, restores in finally.
- Settings tab gets the rpcEnabled checkbox with explainer.

### Documentation

Created this session:
- **`PROCESS-FLOW-AUDIT.md`** — per-role flow enumeration + legacy +
  gap findings (729 lines)
- **`PRE-MAINNET-CHECKLIST.md`** (moved from alpha-4/) — adds §U1-U7
  upgrade-machinery section
- **`alpha-5/V5-VERIFICATION-SNAPSHOT.md`** — on-chain state at v5
- **`alpha-5/DEPLOY-COVERAGE.md`** — every `Datum*.sol` mapped to
  deploy status
- **`alpha-5/extension/RPC-REFACTOR-AUDIT.md`** — extension RPC plan
- **`web/V5-WALKTHROUGH-CHECKLIST.md`** — manual sanity-check sequence

Updated:
- **`STATUS.md`** — bumped to v5
- **`alpha-5/docs/gas-by-role.md`** + `.csv` — refreshed
- **`alpha-5/scripts/deploy.ts`** — added 4 contract deploys, PARAM
  filter for missing contracts, 22 new PG-routable selectors

## Open work — substantive (require go-ahead)

| ID | Item | Effort | Why it's worth doing |
|---|---|---|---|
| GAP-1 | `/advertiser/stake` page | 1–2 hr | `DatumAdvertiserStake` deployed but no UI. Mirrors `/publisher/stake` shape. |
| GAP-3 | EarningsTab event-stream wiring | 1–2 hr | Popup users currently bounce to the webapp for settlement history. |
| GAP-5 | Webapp People Chain XCM refresh trigger UI | 30 min | `/me/identity` lacks the refresh button. |
| GAP-6 | `/protocol/publisher-reputation` inspection page | 30 min | No webapp UI for reading reputation scores. |
| E-LEG-1 | Delete dead extension popup files | 30 min | ~1000 lines: App.legacy, ClaimQueue, FiltersTab, HistoryTab, ReportsTab, UserPanel, PendingDust. (My "Refresh history" edit lives in HistoryTab — would die with the file.) |
| E-LEG-2 | Reconcile walletClient vs walletManager | 2–4 hr | Two parallel wallet abstractions; needs investigation pass before any merge. |

## Open work — hardening continuation

| Item | Effort | |
|---|---|---|
| Full Hardhat test suite re-run from main | 1 min | Confirm 1579 passing still holds at HEAD. |
| Lock-once ratification audit | 30 min | Walk `lockX()` callsites; decide which to fire now to shrink the deployer-key blast radius. |
| Pre-deploy readiness script | 1–2 hr | Catch the next AdvertiserStake-style gap before deploy (would have saved a redeploy today). |
| Architecture pinning doc | 1 hr | One canonical "what is alpha-5 v5" doc that absorbs V5-VERIFICATION-SNAPSHOT + DEPLOY-COVERAGE + the parameter-tunable matrix above. |
| Walk webapp pages on Paseo v5 | 15-20 min (you) | Per `web/V5-WALKTHROUGH-CHECKLIST.md`. Surfaces any drift the snapshot doesn't catch. |

## Recommended pickup order

If you want **one tight commit to start the next session**: the lock-once
ratification audit. It's bounded, clarifies the security surface, and
either produces a small focused commit (firing some locks) or a written
"keep these unlocked because…" decision.

If you want a **user-facing win**: GAP-1 (`/advertiser/stake` page).
The contract is live; the UI gap is felt every time someone tries to
operate as an advertiser at scale on Paseo.

If you want a **safety-net win**: pre-deploy readiness script. It
won't be visible day-to-day but it eliminates a category of future
mistakes (silent PARAM_SETTERS gaps, missing wiring, ABI mismatches).

If you want to **stop adding things and validate**: walk the webapp
per the V5 checklist. Confirms the system actually behaves the way
the docs claim it does.

## What I'd skip

- **Mainnet migration work** — captured in `PRE-MAINNET-CHECKLIST.md`
  §U1-U7. Don't touch this until you're committing to a mainnet date.
- **More token-plane work** — explicit decision earlier in the session
  to hold off until everything else is stable.
- **Webapp redesigns** — it's functional and consistent.
- **More parameter additions** — PG covers the parameters that
  legitimately need to move; adding more is just adding surface area.

## How to resume

```sh
git log --oneline -15           # see the day's commit chain
cat SESSION-LOG-2026-05-23.md   # this file
cat PROCESS-FLOW-AUDIT.md       # the audit findings + flows
cat PRE-MAINNET-CHECKLIST.md    # mainnet-blocking work
cat alpha-5/V5-VERIFICATION-SNAPSHOT.md  # what's on-chain right now
```

The system is in a clean state. The next session can pick up any
single item from "Open work" above without needing to re-establish
context — every commit message includes the rationale, every doc
includes the evidence.
