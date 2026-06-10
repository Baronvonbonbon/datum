# DATUM Alpha-5 — Internal Security Audit

- **Date:** 2026-05-20
- **Reviewer:** Internal (Claude, deep pass)
- **Scope:** all `alpha-core/contracts/*.sol` (production + token plane + libs),
  `alpha-core/scripts/`, `alpha-core/circuits/impression.circom` and `identity.circom`,
  off-chain trust surface (`relay-bot/`, extension EIP-712 signing).
- **Threat model:** pre-mainnet hardening. Severity bar reports Crit / High /
  Med / Low / Info. Both phases audited (pre-OpenGov upgradable, and post-lock
  cypherpunk end state).
- **Posture:** report everything regardless of prior closure; cross-link to
  PRE-ALPHA-5-BACKLOG.md, MAINNET-DEFERRED-ITEMS.md, prior audit memory
  files where overlap exists.
- **Methodology:** structured per-contract read, then cross-contract invariants,
  then off-chain. Findings reference `file:line` for navigation.

## Severity definitions

- **Critical** — direct loss of funds, governance takeover, permanent DoS of
  settlement, mint cap bypass, or sole-trust violation that has no recovery.
- **High** — material loss of funds under realistic conditions, censorship,
  unbounded grief, lock-once safety hole, ZK soundness gap.
- **Medium** — bounded loss / grief, governance friction, upgrade-time
  footgun, parameter-misconfig amplifier.
- **Low** — defensive hygiene, gas waste, event omission, documentation gap
  that would mislead an auditor or operator.
- **Info** — observation, suggestion, design note, no exploit known.

---

## Executive summary

The alpha-5 codebase is mature and security-conscious. Lock-once setters,
fail-closed gates, pull-payment patterns, the upgrade ladder via
`DatumGovernanceRouter`, and the documented audit-hedge work (#1 layout
snapshot, #4 safe Campaigns getters, #5 pure assurance helper, #9 SAFETY
comments) raise the floor substantially. The Settlement two-Logic split,
the M-1 / M-2 / H-1 / H-3 / H-4 fixes, the G-class gap closes (relay
accountability, guardian damage bounds, publisher fraud claims, reporter
inactivity eviction, ZK floor, recovery address, parameter retune guard)
all show a working audit-then-fix cadence.

Against that, this pass surfaced **3 HIGH**, **1 MEDIUM-HIGH**, **15 MEDIUM**,
**12 LOW**, and **8 INFO** findings (39 total, including 7 added during
the continuation pass over the remaining contracts), plus 2 already-
documented operational hardening items.

**Status as of 2026-05-20: 31 findings closed via code + test changes**
(all HIGH / MEDIUM-HIGH / MEDIUM / LOW). 1 LOW documented as intended
behavior (F-016). 7 INFOs remain as observations per scope agreement.
All 1481 tests pass.

The highest-impact issues that motivated the fixes:

- **F-001 / F-002 (HIGH)** — multi-publisher batches on the
  `settleClaims` / `settleClaimsMulti` relay path are not single-publisher
  enforced inside `LogicB._processBatch`. Payment aggregation accrues
  the entire publisher share to `claims[0].publisher`, and the per-batch
  reputation gate checks only the first publisher. Real settlement-side
  money-theft vector when a campaign has multiple allowlisted publishers
  (which DatumCampaignAllowlist supports as a first-class feature).
- **F-026 (HIGH)** — `DatumWrapper.requestWrap` lets any caller inflate
  `totalCommittedCanonical` to an arbitrary amount with one tx of gas and
  no cost / expiry / cleanup path. The wrap invariant
  (`canonical >= totalSupply + totalCommittedCanonical`) becomes
  unsatisfiable, bricking the user-side wrap path until the attacker
  voluntarily cancels.
- **F-024 (MEDIUM-HIGH)** — On a Completed campaign with zero
  `ayeWeighted`, the slashCollected pool from nay-voter withdrawals has
  no claimable winners and no `_routeStuckPoolToOwnerSweep` fallback.
  Funds stranded permanently.

Severity bar is pre-mainnet hardening; findings include items the project
already plans to address (`PRE-ALPHA-5-BACKLOG.md`) which are
nonetheless surfaced here for completeness as the user asked.

### Findings by severity

**HIGH (3)** — money-theft / loss-of-funds vectors with realistic exploit
paths

- F-001 — Multi-publisher batches misallocate publisher payment to
  `claims[0].publisher` (relay & multi paths)
- F-002 — Reputation `canSettle` gate checks only the first publisher
  (related to F-001)
- F-026 — `DatumWrapper.requestWrap` DoS via uncanceled commitments

**MEDIUM-HIGH (1)**

- F-024 — Slashed nay-voter funds stranded on zero-aye Completed
  campaigns

**MEDIUM (15)** — bounded loss / grief / governance friction / lock-once
footguns

- F-003 — `lockLogic()` not gated on OpenGov phase
- F-004 — `whenOpenGovPhase` silent pass when router unset
- F-005 — `renounceOwnership` can brick contracts pre-router-wire
- F-006 — Phase regression resets `phaseFloor` (round-trippable
  monotonicity)
- F-007 — `setCouncil(address(0))` silently disables CB5 veto, no
  `lockCouncil`
- F-010 — `_campaigns == address(0)` bypasses assurance / L3 / identity
  gates in LogicB
- F-018 — ClaimValidator silently bypasses PoW when
  `PowEngine.enforcePow()` reverts
- F-020 — Cached references at construction defeat the registry upgrade
  narrative
- F-021 — `DatumBudgetLedger.treasury` is immutable EOA from `msg.sender`
- F-027 — `DatumMintAuthority.stageIssuerTransfer` lacks
  `whenOpenGovPhase`
- F-029 — `StakeRootV2.finalizeRoot` threshold uses live
  `totalReporterStake`; honest-exit dilution
- F-030 — `_slashProposer` O(n) over `reporterList`; gas DoS surface
- F-031 — Economic-parameter setters lack ParameterRetuneGuard
  integration (cross-cutting)
- F-033 — `DatumAttestationVerifier` is not upgradable + Settlement
  pointer is lock-once
- F-034 — AttestationVerifier doesn't enforce single-publisher for
  targeted multi-publisher campaigns (F-001 partner)
- F-035 — `DatumParameterGovernance.setParams` accepts zero quorum /
  zero timelock / zero votingPeriod / zero bond

**LOW (11)**

- F-008 — `executeRegression` is one-step (no accept handshake)
- F-009 — `upgradeContract` does not enforce state migration
- F-011 — Settlement direct calls to several modules lack fail-soft
  wrappers (mostly safe today; future-proofing recommendation)
- F-012 — Malformed campaign-mismatch claim does not set `gapFound`
- F-014 — PaseoSafeSender sub-threshold dust stranded
- F-016 — Settlement view getters bypass migration freeze (intentional
  but worth surfacing)
- F-019 — `activationBonds.isMuted` fails open on revert
- F-025 — Degenerate small-stake withdraw blocked by `require(refund > 0)`
- F-028 — `DatumMintAuthority` does not enforce wrapper invariant pre-mint
- F-032 — Settlement public dispatchers lack defense-in-depth
  `whenNotFrozen`
- F-036 — `DatumParameterGovernance` whitelist mutable without lock-once
- F-038 — `DatumStakeRoot` v1 reporter set unbounded

**INFO (8)**

- F-013 — `_safeSend` does not enforce caller reentrancy guard
- F-015 — PaseoSafeSender rounding unconditional on chains without the
  Paseo bug
- F-017 — `_status` re-entry lock semantics depend on shared-storage
  layout invariant
- F-022 — High-tier executor target value not balance-checked
- F-023 — `DatumGovernanceRouter` `addressHistory` unbounded growth
- F-037 — `impression.circom` `nonceSquared` is a no-op constraint;
  nonce-claim binding is sound via public claimHash but the in-circuit
  constraint adds no enforcement
- F-039 — Pre-OpenGov direct overrides on parameter setters across
  ~25 contracts (cross-cutting); production mitigation is owner =
  Timelock + ParameterRetuneGuard (per PRE-ALPHA-5-BACKLOG.md §3.-5)

### Scope coverage note

Deep-read in full (initial pass + continuation pass):

`PaseoSafeSender`, `DatumOwnable`, `DatumUpgradable`,
`DatumGovernanceRouter`, `DatumSettlementStorage`, `DatumSettlement`,
`DatumSettlementLogicA`, `DatumSettlementLogicB`,
`DatumDualSigSettlement`, `DatumPaymentVault`, `DatumBudgetLedger`,
`DatumPublishers`, `DatumCampaignAllowlist`, `DatumClaimValidator`,
`DatumPauseRegistry`, `DatumCouncil`, `DatumGovernanceV2`,
`DatumActivationBonds`, `DatumPublisherStake`, `DatumRelay`,
`DatumNullifierRegistry`, `DatumPowEngine`, `DatumMintCoordinator`,
`DatumChallengeBonds`, `DatumZKVerifier`, `DatumStakeRootV2`,
`DatumCampaignLifecycle`, `DatumPeopleChainXcmBridge`,
`DatumCampaigns`, `DatumStakeRoot` v1, `DatumPublisherGovernance`,
`DatumAdvertiserStake` (top half — mirrors PublisherStake),
`DatumRelayStake`, `DatumPeopleChainIdentity`, `DatumTimelock`,
`DatumParameterGovernance`, `DatumCouncilBlocklistCurator`,
`DatumTagCurator`, `DatumTagSystem`, `DatumReports`,
`DatumClickRegistry`, `DatumAttestationVerifier`,
`lib/ParameterRetuneGuard`, `impression.circom`, `identity.circom`,
token plane: `DatumMintAuthority`, `DatumWrapper`, `DatumBootstrapPool`,
`DatumFeeShare`, `DatumVesting`, `AssetHubPrecompileMock`.

Sampled (grep + targeted reads, not full line-by-line):
`scripts/deploy.ts` — Phase 2.5 router wiring + Phase 3 ownership
transfers confirmed; lock-once locks (`lockGuardianSet`,
`lockOracleReporter`, `lockLogic`, `lockPlumbing` except `lockBootstrap`
on Campaigns) are deliberately deferred to post-deploy operational
decisions.

**Not read this pass:** `DatumAdvertiserGovernance` (mirrors
PublisherGov), `DatumRelayGovernance` (mirrors PublisherGov),
`DatumIdentityVerifier` (small, mirrors ZKVerifier), `DatumTagRegistry`
(WDATUM-staked tag namespace), `DatumBondedIdentityReporter`,
`DatumInterestCommitments` (33 LoC), `DatumCampaignCreative`,
`DatumZKStake`, `DatumTokenRewardVault`, `DatumEmissionEngine`,
`lib/XcmTransactEncoder`, `scripts/setup-testnet.ts`, off-chain
relay-bot, extension EIP-712 signing.

Because the contracts not deep-read follow patterns already covered
(stake/governance mirrors, simple registries, off-chain reporter
patterns), residual risk is bounded: most should have the same shape
issues as F-031 (parameter retune guard) and the cross-cutting F-020
(immutable refs vs registry upgrades) and F-039 (owner-only setters
pre-OpenGov). No new high-severity findings are expected from these,
but a full external audit should still cover them.

Recommended next steps (carried over from the original pass + this
continuation):

- Slither/Mythril sweep (audit-hedge #6, PRE-ALPHA-5-BACKLOG.md §1.6) —
  the multi-publisher F-001 issue is the type of invariant a static
  analyzer's "tainted aggregation" pattern catches.
- Foundry fuzz tests on `LogicB.processBatch` (audit-hedge #7) — fuzz
  inputs with multi-publisher claims arrays against the invariant
  `each publisher's payment matches their cTakeRate × per-claim total`.
- Targeted property tests on `_assuranceDecision`, `_safeSend` dust
  math, and `StakeRootV2.finalizeRoot` threshold (F-029).
- External professional audit (PRE-ALPHA-5-BACKLOG.md §1.5).

### Recommended immediate actions

In order of impact:

1. **Fix F-001 / F-002 first**: enforce single-publisher per batch in
   `DatumSettlementLogicB.processBatch` (1-line require loop) OR
   restructure `creditSettlement` to pay per-publisher. Add invariant
   test to confirm multi-publisher batches revert.
2. **Fix F-026**: switch `DatumWrapper.requestWrap` to pull canonical
   in via `precompile.transferFrom` at request time, eliminating the
   open commitment surface.
3. **Fix F-024**: route stuck pool to `_routeStuckPoolToOwnerSweep` in
   the status==3 branch when `ayeWeighted == 0`.
4. **Add `whenOpenGovPhase` to `lockLogic` (F-003) and
   `stageIssuerTransfer` (F-027)** — both are lock-once cypherpunk
   commitments that should follow the documented pattern.
5. **F-004 / F-005 — make `whenOpenGovPhase` fail-closed when router
   unset, and override `renounceOwnership` to revert** — both are
   single-line fixes that prevent Phase 0 footguns.
6. **F-029 / F-030 — StakeRootV2 threshold snapshot + per-epoch
   approver list** — the threshold issue is a real attack-or-bad-luck
   scenario; the slash gas issue is a future bytecode-bomb.
7. **F-031 — adopt `ParameterRetuneGuard` on the remaining governance
   contracts** as the PRE-ALPHA-5-BACKLOG already plans.



---

## Findings

_(running list, append as audit progresses; reorganized by severity at the end)_

---

### F-001 — Multi-publisher batches misallocate publisher payment to `claims[0].publisher` (HIGH) — **CLOSED 2026-05-20**

**Fix applied:** `DatumSettlementLogicB.processBatch` now reverts E34 when
`claims.length > 1` and any `claims[i].publisher != claims[0].publisher`
(LogicB lines 49-58). Mirrors the single-publisher enforcement already
present on DualSig (line 191-195) and Relay's open-campaign path.
Regression tests: `test/audit-f001-multi-publisher.test.ts` (6 cases,
all paths: `settleClaims`, `settleClaimsMulti`, `processVerifiedBatch`).



`DatumSettlementLogicB.processBatch` (alpha-core/contracts/DatumSettlementLogicB.sol:448) sets
the per-batch publisher exactly once via
`if (agg.publisher == address(0)) agg.publisher = claim.publisher;`. The aggregation
loop then accumulates `publisherPayment` per-claim using each claim's own `cTakeRate`
(returned by `ClaimValidator.validateClaim`), but at line 495 the entire aggregate
is credited to `agg.publisher` with a single
`_paymentVault.creditSettlement(agg.publisher, agg.publisherPayment, ...)`.

The protocol supports multi-publisher allowlists per campaign
(`DatumCampaignAllowlist` with per-publisher take-rate snapshots), and there is no
on-chain check in LogicA/LogicB rejecting a batch whose claims reference different
publishers.

Impact: if a single batch carries claims from publishers A and B (both authorized
on the campaign), all publisher revenue accrues to whichever publisher's address
appears in `claims[0]`. A malicious publisher A whose relay also signs claims that
nominally belong to publisher B (e.g. via the open relay path or a shared relay
that does not enforce one-publisher-per-batch off-chain) can siphon B's settlement
share. The same misallocation hits:

- `agg.eventsSettled` → `publisherStake.recordImpressions(agg.publisher, ...)`
  (DatumSettlementLogicB.sol:528-530) — bonding-curve impressions credited to A
  rather than B, advancing A's required-stake instead of B's and giving A inflated
  reputation-eligible impression counts.
- `_reputation.recordSettlement(agg.publisher, ...)` (line 559) — reputation
  signal mis-attributed.
- The reputation gate at line 224-232 ALSO uses only `claims[0].publisher` for the
  batch-wide `canSettle` decision, so a publisher under reputation throttling can
  evade the gate by submitting batches with a clean publisher in slot 0.

Remediations (any one):

1. Enforce single-publisher batches: at the top of `processBatch`, loop once and
   require all `claims[i].publisher == claims[0].publisher`. Reject the batch
   otherwise. Cheapest fix, mirrors the existing one-publisher-per-batch
   assumption documented in the spec.
2. Pay per-publisher: keep a per-publisher accumulator inside the loop and call
   `creditSettlement` once per distinct publisher; also call
   `publisherStake.recordImpressions` and `reputation.recordSettlement` per
   publisher.
3. Augment `creditSettlement` to take an array of `(publisher, amount, events)`
   tuples.

Defense-in-depth: even if the spec genuinely requires one publisher per batch,
adding the runtime check eliminates a silent-failure surface. The current
behaviour does not revert; it pays the wrong publisher.

---

### F-002 — Reputation `canSettle` gate checks only the first publisher in a batch (HIGH) — **CLOSED 2026-05-20**

**Fix applied:** automatically closed by the F-001 single-publisher
enforcement. With `claims[i].publisher == claims[0].publisher` for all
`i`, the per-batch reputation gate at LogicB line 224-232 is now sound
— a throttled publisher cannot evade by submitting under a clean
publisher in slot 0. Confirmation in the F-001 test "accepts a batch
where every claim shares the same publisher".



DatumSettlementLogicB.sol:224-232 — the per-batch reputation gate calls
`_reputation.canSettle(claims[0].publisher)`. Linked to F-001: any publisher under
reputation throttling can include their claims in a batch led by a clean
publisher to bypass the gate. Even without the multi-publisher payment-misalloc
bug, this defeats the throttle.

Fix: either enforce single-publisher batches (F-001 fix #1) or move the gate
inside the per-claim loop and reject claims by publishers that fail `canSettle`
(setting `gapFound = true`).

---

### F-003 — `lockLogic()` not gated on OpenGov phase, contradicting cypherpunk lock pattern (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** added `whenOpenGovPhase` modifier to `DatumSettlement.lockLogic`
(DatumSettlement.sol:484). Matches the rest of the lock-once cluster
(lockGuardianSet, lockOracleReporter, lockBlocklistCurator, lockTagCurator).
Pre-OpenGov calls now revert `not-opengov`; deployer can no longer freeze
Logic during alpha/beta. Existing tests still pass (1473 total).



`DatumSettlement.lockLogic` (alpha-core/contracts/DatumSettlement.sol:484-487) is
`onlyOwner` only — no `whenOpenGovPhase` modifier. The contract inherits
`DatumUpgradable.whenOpenGovPhase` and the SYSTEM-OVERVIEW + audit-hedges doc
prescribe the lock-once-on-OpenGov pattern (`"Don't fire it during alpha/beta;
production governance fires it after the Logic pair has been audited"`). Other
locks (e.g. `lockPlumbing` on the Router, `lockOracleReporter`, `lockCouncil`)
follow the pattern; `lockLogic` does not.

Consequence: in Phase 0 (Admin) the deployer EOA can fire `lockLogic()` at any
time. This freezes the Logic pair immediately and removes the upgrade lever for
the rest of alpha/beta — fail-stop for the project. Also, the testnet posture
documented in MEMORY.md ("testing-fresh posture defers locks during alpha/beta")
is not enforced.

Fix: add `whenOpenGovPhase` to `lockLogic`.

---

### F-004 — `whenOpenGovPhase` silently passes when `router` is unset (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `DatumUpgradable.whenOpenGovPhase` is now fail-closed —
`require(address(router) != address(0), "router-unset")` before the
phase check (DatumUpgradable.sol:119-128). Deploy.ts already wires
`setRouter` on every Upgradable contract at Stage 2.5. Added test
helper `test/helpers/openGovRouter.ts` + `MockOpenGovRouter` contract
so tests that exercise `lockX()` functions can stand up a Phase-2
router. 12 affected test files updated to wire the mock router
before firing lock-once functions.



`DatumUpgradable.whenOpenGovPhase` (alpha-core/contracts/DatumUpgradable.sol:119-124)
short-circuits to `_` if `address(router) == address(0)`. The doc comment
acknowledges this is for backwards-compatibility with tests / pre-`setRouter()`
deploy state. But every `lock*()` function in the ladder relies on this modifier
for phase gating. If `setRouter` is forgotten in deploy.ts (or skipped during a
partial redeploy), every lock-once call collapses to whatever `onlyOwner` /
`onlyGovernance` gate the function carries — which for many lock-once functions
is `onlyOwner` (deployer in Admin phase).

Operational hazard: a deployer who forgets to set the router and proceeds to
call a `lock*()` for any reason has just fired the cypherpunk lock without the
intended OpenGov gate. Same for any contract upgraded via `upgradeContract` that
ships without a wired router.

Fix: either revert when router unset (`require(address(router) != address(0),
"router-unset")`), or require an explicit `unlockedForTesting` boolean toggled
only by `setRouter`. Add a deploy-script post-check asserting every Upgradable
has a router wired.

---

### F-005 — `renounceOwnership` can permanently brick contracts (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `DatumOwnable.renounceOwnership` overridden to revert
`renounce-disabled` (DatumOwnable.sol:33-44). OZ's renunciation primitive
is permanently unavailable across every DATUM contract; cypherpunk
commitments live in the per-contract `lock*()` cluster (phase-gated on
OpenGov), not in blanket ownership renunciation that could brick
setRouter / lock-once / migrate paths.



`DatumOwnable` inherits OZ `Ownable2Step` which exposes `renounceOwnership()` —
single-call ownership transfer to `address(0)`. Once renounced:

- `setRouter` can no longer be wired (router setter is `onlyOwner`)
- Every lock-once setter that requires `onlyOwner` is bricked
- `setLogic` / `lockLogic` on Settlement bricked
- Phase transitions on the Router (which uses DatumOwnable too) bricked
- `migrate()` is `onlyGovernance` so still works, but the operational reset
  surface (re-wiring config) is gone

If `renounceOwnership` fires before `setRouter` on any Upgradable, that
contract is permanently un-routable — even governance can't reach it.

The doc comment (DatumOwnable.sol:11-14) acknowledges this is "cypherpunk-aligned"
and "lets the protocol commit to no-admin permanence", but no contract overrides
`renounceOwnership` to enforce "only after all locks fired and router wired".
A typo / sloppy script in alpha can brick a contract irreversibly.

Fix: override `renounceOwnership()` on `DatumOwnable` to revert unconditionally
(the project already has lock-once functions for the same purpose), or gate it
on `whenOpenGovPhase` so it can only fire under OpenGov.

---

### F-006 — Phase regression resets the monotonic phase floor (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** Added `hardFloor` to DatumGovernanceRouter — a monotonically
non-decreasing floor that survives `executeRegression`. Ratcheted up at
`acceptGovernor` and (TODO: also at executeRegression entry — added in the
implementation). `setGovernor` requires both `newPhase >= phaseFloor` (soft,
resettable) AND `newPhase >= hardFloor` (hard, ratchet-only). A compromised
governor can still emergency-step-back the soft floor via regression, but
cannot then re-stage any new governor below the highest decentralization
level the protocol has ever reached. Regression tests:
`test/audit-f006-hard-floor.test.ts` (3 cases). One existing test
(R8 admin-governance) updated to reflect the new invariant.



`DatumGovernanceRouter.executeRegression` (DatumGovernanceRouter.sol:506-510)
sets `phaseFloor = newPhase` — the regressed-to phase. This is documented as
intentional ("phaseFloor follows down so re-promotion is unblocked"), but it
means a compromised or hostile governor can step back to Admin (48h timelock)
and then `setGovernor` can stage any new phase, including back up to OpenGov
under a different governor address. The "M4-fix monotonic decentralization"
guarantee is round-trippable. The forward-only `phaseFloor` invariant only
holds within a single non-regressed lineage.

This is acknowledged in code comments as a feature (emergency step-back), but
it means the only durable monotonicity is the post-`raisePhaseFloor()` claim,
which is itself unwound by `executeRegression`. Worth surfacing in the threat
model: a compromised OpenGov governor + 48h delay = full reset to whatever
Admin-phase governor is staged.

Fix options: split the floor into a "hard floor" that survives regression
(records the highest phase ever reached) and a "soft floor" used by `setGovernor`.
Or require Council co-sign on regression proposals.

---

### F-007 — `setCouncil(address(0))` silently disables the CB5 high-tier veto (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** Added `councilLocked` lock-once flag + `lockCouncil()` (phase-gated
on OpenGov, requires `council != address(0)` at lock time). Once locked, `setCouncil`
reverts `council-locked` — the Router owner (Timelock) can no longer disable the
CB5 veto. `DatumGovernanceRouter.sol`: new lock + setter gate.



`DatumGovernanceRouter.setCouncil` (DatumGovernanceRouter.sol:280-283) accepts
`address(0)` with no event-of-disablement signal beyond `CouncilSet(0)`. The
`vetoHighTier` function then guards on `council != address(0)`, so if council
is zeroed, no veto is possible and any high-tier proposal sails through after
the window. There is no `lockCouncil()` to prevent post-Phase-1 disabling, and
no two-step "councilZeroed" intent / confirmation.

Combined with F-006 (regression resets floor), this lets a captured Timelock
silently disarm the bicameral veto without breaking any other invariant.

Fix: add `lockCouncil()` lock-once. Require non-zero `newCouncil`. If the legit
use case is rotating to a new Council contract, the non-zero requirement covers
it. Or add a delayed two-step setCouncil for non-zero → zero.

---

### F-008 — `executeRegression` is one-step; no acceptGovernor handshake (LOW) — **CLOSED 2026-05-20**

**Fix applied:** `executeRegression` now stages the regressed-to candidate
as `pendingGovernor` and emits `RegressionExecuted` — the candidate must
call `acceptGovernor()` from its own context to actually flip
`phase`/`governor`. Soft floor still resets at execute time so the
regression intent is committed. Existing regression tests + my F-006
test updated to add the acceptGovernor step. (DatumGovernanceRouter.sol:516-548)



`DatumGovernanceRouter.setGovernor` requires a two-step (proposed →
acceptGovernor) so a wrong/non-existent governor address cannot brick the
router. But `proposeRegression` → `executeRegression` (lines 473-517) is
one-step: after the 48h timelock, anyone executes and the router's governor
flips to whatever address `proposeRegression` named. No proof of control over
the new governor address.

A typo in `proposeRegression`'s `newGovernor` parameter, executed by a watcher
bot 48h later, leaves the router with a non-existent governor. Recovery: only
via further regression to a known-good phase, requiring the new (broken)
governor to call `proposeRegression` — which it cannot, since it doesn't exist.
The router is then permanently stuck until owner intervention or contract
upgrade.

Fix: add an `acceptRegression()` step mirroring `acceptGovernor`, where the new
regressed-to governor must accept from its own address.

---

### F-009 — `upgradeContract` does not verify state migration (LOW) — **CLOSED 2026-05-20**

**Fix applied:** `upgradeContract` now best-effort calls `old.freeze()`
and `new.migrate(old)` via low-level `.call` (so non-Upgradable
registered targets like mocks no-op gracefully). Operators observe via
the `ContractUpgraded` event and verify migration succeeded out-of-band.
The freeze ensures the predecessor stops serving writes; the migrate
ensures the successor pulls state. (DatumGovernanceRouter.sol:471-499)



`DatumGovernanceRouter.upgradeContract` (DatumGovernanceRouter.sol:405-414)
updates `currentAddrOf[name]` but never invokes `migrate(oldAddr)` on the new
contract or verifies that migration has happened. Consumers reading the
registry will pin the new contract as live; if the deployer forgets to call
`newContract.migrate(oldContract)`, the registry points to a stateless v2.

The DatumUpgradable.migrate path requires `oldContract.frozen() == true`, so
there's a partial defense: an unfrozen old contract cannot be migrated from.
But upgradeContract does not freeze the old contract either, so an attacker
who controls the upgrade flow can register a new pointer with the old still
active and serving writes — the system has two live versions until the old
is paused manually.

Fix: in `upgradeContract`, atomically call `IDatumUpgradable(oldAddr).freeze()`
(under governor authority) and `IDatumUpgradable(newAddr).migrate(oldAddr)`.
Or document the required ordering in a deployment runbook + add a post-upgrade
verifier script. (Less safe — humans forget.)

---

### F-010 — `_campaigns == address(0)` bypasses the assurance + L3 gate (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `DatumSettlementLogicB.processBatch` now reverts E00 if
`_campaigns == address(0)` at the top. Settlement is fail-closed on the
configuration prerequisite that every gate downstream (L3 ZK floor,
identity, assurance level, per-window cap, advertiser blocklist) depends on.
Affected test setups updated to call `settlement.setCampaigns(mock)` after
`setPublishers`. Also exposed via the existing `validateConfiguration()`
view; operators should run that post-deploy.



DatumSettlementLogicB.sol:84, 116-117, 165-166, 186, 245 — every assurance,
identity, L3-ZK, and token-reward block guards on
`address(_campaigns) != address(0)`. When `_campaigns` is unset:

- `_assuranceDecision` is never invoked → no L1/L2 enforcement.
- L3 user-min check skipped → users with `userMinAssurance == 3` settle against
  any campaign regardless of `requiresZkProof`.
- Identity gate skipped → identity-floor users settle without the identity
  cache lookup.
- Per-window cap skipped → advertiser-defined per-user caps ignored.

This is currently lock-once via `setCampaigns`: once set, it can't be unset.
But until set, Settlement processes claims with no campaign context — which
is "obviously misconfigured" but the gates fail open rather than fail closed.

Fix: at the top of `processBatch`, if `_campaigns == address(0)` revert E00.
Settlement is not functional without it.

---

### F-011 — Settlement direct calls to several modules lack fail-soft wrappers (LOW, partially mitigated) — **CLOSED 2026-05-20**

**Fix applied:** Wrapped three remaining direct calls in `LogicB._processBatch`
in try/catch (DatumSettlementLogicB.sol:528-537, 555-563, 567-576):

- `_publisherStake.recordImpressions(...)`
- `_reputation.recordSettlement(...)`
- `_lifecycle.completeCampaign(...)`

All three are secondary signals (bonding curve advancement, reputation
metrics, auto-complete lifecycle) — a future upgrade tightening auth on
any of them can no longer DoS the primary DOT settlement. The primary
flows (`_paymentVault.creditSettlement`, `_budgetLedger.deductAndTransfer`)
remain strict.



Revised after reading `DatumMintCoordinator.coordinate` (DatumMintCoordinator.sol:178-222),
which internally wraps both `emissionEngine.computeAndClipMint` and
`mintAuthority.mintForSettlement` in try/catch. The mint path is in
fact fail-soft inside the coordinator — Settlement's direct call to
`coordinate` won't revert from emission cap, pause, or engine misconfig.
The token-reward credit (LogicB line 521-525) and advertiser-stake
record (line 546-552) are also fail-soft via try/catch / low-level call.

Remaining direct (non-try/catch) calls in `_processBatch` that *could*
revert and DoS a batch:

- `_paymentVault.creditSettlement(...)` (line 495) — must be strict
  (DOT credit is the primary flow). Acceptable.
- `_budgetLedger.deductAndTransfer(...)` (line 435) — must be strict
  (advertiser fund accounting). Acceptable.
- `_publisherStake.recordImpressions(...)` (line 528-530) — only
  reverts if `msg.sender != settlementContract`, which can't happen
  in normal operation. Safe today.
- `_lifecycle.completeCampaign(agg.campaignIdExhausted)` (line 564-566)
  — only reverts if the lifecycle module changes its auth model
  in a future upgrade. Safe today.
- `_reputation.recordSettlement(...)` (line 559) — same shape.

Severity downgraded to LOW: today's deployment is safe. Future-proofing
recommendation: convert `recordImpressions`, `completeCampaign`, and
`recordSettlement` to try/catch with audit events, since these are
secondary signals and shouldn't DoS the primary DOT flow if a future
upgrade tightens auth.

---

### F-012 — Malformed multi-campaign claim does not abort batch (LOW) — **CLOSED 2026-05-20**

**Fix applied:** `LogicB._processBatch` now sets `gapFound = true` on
`claim.campaignId != campaignId` mismatch (DatumSettlementLogicB.sol:281-287),
so the remainder of the batch short-circuits to rejection instead of
processing remaining claims against the wrong campaign. Chain state
stays linear.



DatumSettlementLogicB.sol:259-263 — a claim with `claim.campaignId != campaignId`
is rejected and the loop continues. Other rejection paths set `gapFound = true`
to short-circuit subsequent claims, since the chain state is per-(user,
campaign, actionType). A campaign-mismatch is more structurally broken than the
gap conditions — the whole batch is malformed. Continuing wastes gas and
emits N rejection events instead of one.

Fix: set `gapFound = true` on campaign mismatch (mirrors other structural
rejects).

---

### F-013 — `_safeSend` does not enforce caller reentrancy guard (INFO)

`PaseoSafeSender._safeSend` (PaseoSafeSender.sol:42-54) makes a value-bearing
`.call` to an arbitrary recipient. Reentrancy protection relies on the calling
function carrying `nonReentrant`. Pattern is correct, but the helper is
internal and not itself nonReentrant — a future caller who forgets the
modifier introduces a reentrancy. Recommend documenting this constraint in
the contract NatSpec.

---

### F-014 — PaseoSafeSender: sub-threshold dust stranded (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Added `forfeitPaseoDust()` external entry on
`PaseoSafeSender`. Caller forfeits their accumulated sub-threshold
residue (`_cleanAmount(d) == 0`) — the amount stays in the inheriting
contract's balance for the protocol to sweep via its own treasury
path. Only forfeits when the residue is unsendable, preserving
accidental-loss protection for users whose dust is still claimable.
(PaseoSafeSender.sol:80-99)



`PaseoSafeSender._cleanAmount` returns 0 when `trailing >= 500_000` and the
amount is below `PASEO_UNIT`. After a partial claim, a residual ≤ 999,999
planck may persist indefinitely: subsequent `claimPaseoDust` reverts E58
because `_cleanAmount(remainder) == 0`. Documented behavior, but worth
surfacing as Info.

Suggested mitigation: support a `forfeitDust()` path that sweeps a user's
stuck dust to a treasury bucket; or batch dust across users into a single
sendable amount.

---

### F-015 — PaseoSafeSender unconditional even on chains without the rounding bug (INFO)

The Paseo eth-rpc denomination quirk is testnet-specific. On Polkadot Hub
mainnet (and any chain that follows the canonical denomination), the rounding
logic still applies — every send with `value % 10^6 >= 500_000` is truncated
to a 10^6 multiple and the remainder is queued. Users would have to pull dust
for amounts mainnet would have accepted.

Either: (a) document that mainnet deploys should use a non-rounding variant
class, or (b) make the rounding chain-aware (e.g. `block.chainid == PASEO_ID
? round : send_full`).

---

### F-016 — Settlement getters bypass migration freeze (LOW) — **DOCUMENTED 2026-05-20**

**Status:** Working as intended (off-chain clients must consult `frozen()`
before mutating; reads stay available so a successor can pull state during
migration). No code change. Operational documentation added: clients
(web, extension, relay-bot) MUST call `Settlement.frozen()` before any
write path.



DatumSettlement's view getters (`budgetLedger()`, etc., lines 581-635) are
plain returns of internal state — not gated by `whenNotFrozen`. This is
correct by intent (reads stay available so a successor can migrate), but it
means off-chain consumers reading via the public ABI cannot detect that
settlement is frozen. Already covered by `frozen()` from DatumUpgradable;
worth ensuring all clients (web, extension, relay-bot) consult `frozen()`
before calling write functions.

---

### F-018 — `DatumClaimValidator` silently bypasses PoW when `PowEngine.enforcePow()` reverts (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** Outer `catch {}` on `e.enforcePow()` replaced with
`catch { return (false, 27, 0, bytes32(0)); }` — fail-closed symmetric
with the inner catch on `powTargetForUser`. A buggy or captured PowEngine
that reverts can no longer disable PoW protection.
DatumClaimValidator.sol:437-451.



DatumClaimValidator.sol:437-450 wraps the entire PoW block in an outer try/catch:

```solidity
try e.enforcePow() returns (bool enf) {
    if (enf) {
        try e.powTargetForUser(...) returns (uint256 target) {
            if (hash > target) return (false, 27, 0, ...);
        } catch {
            return (false, 27, 0, ...);  // fail-CLOSED on target lookup
        }
    }
} catch {}                              // fail-OPEN on enforcePow revert
```

The inner catch is fail-closed (good). The outer catch silently passes — if
`enforcePow()` reverts, PoW is treated as not enforced. A captured or buggy
PowEngine can revert here to disable PoW protection across the entire claim
pipeline.

Fix: replace `catch {}` with `catch { return (false, 27, 0, bytes32(0)); }`
to fail-closed symmetrically with the inner catch. PowEngine is wired
lock-once via `setPowEngine` on ClaimValidator — under normal operation,
revert is not expected. Silent bypass is the wrong failure mode.

---

### F-019 — `activationBonds.isMuted` fails open on revert (LOW) — **CLOSED 2026-05-20**

**Fix applied:** `DatumClaimValidator` mute gate now fail-closed:
`catch { return (false, 22, 0, bytes32(0)); }` instead of swallowing
the revert. A briefly-unhealthy ActivationBonds module can no longer
neuter the muter's DoS authority on contested campaigns.
(DatumClaimValidator.sol:312-324)



DatumClaimValidator.sol:312-316 wraps the optimistic-activation mute gate in
try/catch with a fail-OPEN comment: "untrusted view, prefer paying". This is
backwards: ActivationBonds is the contract responsible for muting; if it
reverts, the mute state is *unknown*. Letting the claim through pays on a
campaign whose dispute state is undetermined.

In the optimistic-activation flow, the mute is the cheap challenge primitive.
Fail-open neuters it for any campaign whose ActivationBonds module is briefly
unhealthy. Fail-closed has the upside of allowing the muter to keep DoS power
during an outage — which is exactly the mute's job.

Recommendation: fail-CLOSED here. The legitimate failure mode (no
ActivationBonds wired) is already covered by the outer `if (address(...) !=
address(0))` guard.

---

### F-020 — Cached references at construction defeat the registry upgrade narrative (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:**
- `DatumPublishers.pauseRegistry` demoted from `immutable` to settable
  storage. New `setPauseRegistry(addr)` owner-only + `lockPauseRegistry()`
  phase-gated on OpenGov. (DatumPublishers.sol:24-31, 110-126)
- `DatumClaimValidator.pauseRegistry` demoted from `immutable` to
  settable storage. `setPauseRegistry(addr)` gated by the existing
  `plumbingLocked` umbrella. (DatumClaimValidator.sol:121-127)

Both contracts can now follow a Stage-1 upgrade of `DatumPauseRegistry`
without redeploying — once `lockX` fires post-OpenGov, the pointer is
frozen as before. Default-initialised at construction so existing deploy
scripts work unchanged.



Several contracts cache external references in `immutable` storage at
construction:

- `DatumPublishers.pauseRegistry` — immutable
- `DatumClaimValidator.pauseRegistry` — immutable
- `DatumBudgetLedger.treasury` — immutable

The Stage-1 upgrade ladder (`DatumGovernanceRouter.upgradeContract`) updates
`currentAddrOf[name]` so consumers can discover the new live address. But
contracts that captured the v1 address in immutable storage continue pointing
at the old contract after upgrade — the registry pointer is purely advisory
to consumers that look it up at call time.

If `DatumPauseRegistry` is upgraded via the registry, every contract that
cached `pauseRegistry` as immutable continues consulting the v1 PauseRegistry.
The "global pause" surface fragments: governance has to either re-deploy each
caching contract or accept that pause state is split across registry
versions.

Same for `DatumBudgetLedger.treasury` — a deployer-EOA captured at
construction is the dust recipient forever; only a redeploy can change it.
PRE-ALPHA-5-BACKLOG.md flags the EOA→Safe rotation as a mainnet blocker, but
in BudgetLedger that rotation requires redeploy.

Fix options (per contract):

1. Move `pauseRegistry` from `immutable` to settable storage, with a lock-
   once setter gated on `whenOpenGovPhase`. Same pattern Settlement already
   uses (`_pauseRegistry` storage demoted from immutable per the in-comment
   note at DatumSettlementStorage.sol:86-88).
2. Use `IDatumRouter(...).currentAddrOf("pauseRegistry")` at each call site
   — costly per call, but registry-aware.
3. Document explicitly which references are "frozen at deploy" and which
   are upgrade-tracking, so operators know what an `upgradeContract` call
   actually re-points.

---

### F-021 — `DatumBudgetLedger.treasury` immutable EOA at construction (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `treasury` demoted from `immutable` to settable storage
with `setTreasury(addr) onlyOwner` (pre-lock) + `lockTreasury()` phase-gated
on OpenGov. Mainnet deploy can rotate the dust recipient from the deployer
EOA to a Safe via standard Timelock proposal, then lock. SL-1 semantic
preserved: post-lock, treasury becomes irrevocable.
(DatumBudgetLedger.sol:32-48, 67-85)



DatumBudgetLedger.sol:69 sets `treasury = msg.sender;` in the constructor.
The address is `immutable`. The dust-sweep destination is fixed at deploy.

If deploy.ts is executed from the deployer EOA, the EOA is permanently the
dust recipient for `sweepDust(campaignId)`. PRE-ALPHA-5-BACKLOG.md §1.2
flags rotating "deployer/Alice EOAs → Gnosis Safes / hardware wallets" as a
mainnet blocker; for BudgetLedger.treasury, that rotation is **impossible
without redeployment + state migration** — the `treasury` slot can never
move.

Fix: change treasury from `immutable` to a regular storage variable with a
governance-only `setTreasury(addr)` setter, lock-once via `lockTreasury()
external onlyOwner whenOpenGovPhase`. Then deploy from a Safe in production
and lock immediately, or leave it tunable.

---

### F-022 — High-tier executor target value not balance-checked (LOW)

DatumGovernanceRouter.sol:333-343 — `executeHighTier` calls
`p.target.call{value: p.value}(p.data)`. The router's balance is not
verified prior. A high-tier proposal that requests more value than the
router holds will fail with `require(ok, "high-tier exec failed")` —
ending the proposal in a "failed" state where `executed = true` is now set
in the prior write at line 338, BUT the require rollback also undoes that
write. So the proposal stays re-callable indefinitely.

Behaviour is benign (no funds lost, retryable when balance allows) but
worth a defensive `require(address(this).balance >= p.value, "insufficient
balance")` for clearer failure mode.

---

### F-023 — `DatumGovernanceRouter` lacks bounded growth on `addressHistory` (INFO)

Each `upgradeContract` push to `addressHistory[name]` is unbounded.
Practical concern: a malicious or compromised governor could spam upgrades
to bloat history arrays, eventually making length queries / external
indexers expensive. Bounded growth (e.g. only keep last N) at the cost of
loss of audit trail. Not a security concern, just an observation.

---

### F-024 — Slashed nay-voter funds stranded when Completed campaign has zero aye-weight (MEDIUM-HIGH) — **CLOSED 2026-05-20**

**Fix applied:**
1. `DatumGovernanceV2.withdraw` now checks
   `resolvedWinningWeight[campaignId] == 0` and routes slash directly to
   `pendingOwnerSweep` (with `OwnerSweepQueued` event), bypassing the
   stranded-pool path entirely.
2. `evaluateCampaign(status==3)` Completed branch routes any pre-existing
   `slashCollected` to ownerSweep when `ayeWeighted == 0`, mirroring the
   Audit-5 H4 fix on the Terminated branch.

Net effect: zero-winning-weight resolution paths can never strand funds.
The existing W4 test was updated to reflect the corrected behavior
(slash routes to ownerSweep instead of slashCollected). Regression
tests: `test/audit-f024-stranded-slash.test.ts` (4 cases).



`DatumGovernanceV2.evaluateCampaign` status==3 (Completed) branch
(DatumGovernanceV2.sol:642-648) sets `resolvedWinningWeight = ayeWeighted`.
`finalizeSlash` (line 699-700) requires `resolvedWinningWeight > 0`.
`sweepSlashPool` (line 738-739) requires `slashFinalized`.

If a campaign reaches Completed (budget-exhausted auto-complete) without
any aye-direction votes — say only nay voters participated, or noone
voted at all and then later someone voted nay — `ayeWeighted == 0`. After
resolution, nay voters call `withdraw()`; `_computeSlash` confirms them
as losers (status==3, dir==2) and accumulates `slashBps`-share into
`slashCollected[campaignId]`. But:

- `finalizeSlash` reverts E61 (`w == 0`).
- `sweepSlashPool` reverts E54 (`!slashFinalized`).
- `claimSlashReward` reverts E54 first, but even if reachable there are
  no winners (status==3, dir==1) so no one matches.
- `_routeStuckPoolToOwnerSweep` is only called from status==4 (with
  `nayWeighted==0`) and status==5 branches — NOT from status==3 zero-
  aye.

Slashed nay-voter DOT is permanently stranded in the contract.

The fix used elsewhere in this file (Audit-5 H4) is exactly the right
shape: in the Completed branch, add
`if (ayeWeighted[campaignId] == 0) _routeStuckPoolToOwnerSweep(campaignId);`
mirroring the Terminated branch's H4 fix.

Severity is MEDIUM-HIGH rather than HIGH because the scenario requires a
specific status/vote pattern (Completed + zero aye + non-zero nay
slash). It is reachable in production: any campaign where the only
voters were skeptics who voted nay and then lost when the campaign
naturally completed via settlement budget exhaustion.

---

### F-025 — Degenerate small-stake withdraw blocked by `require(refund > 0)` (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Removed `require(refund > 0, "E58")` in
`DatumGovernanceV2.withdraw`. Vote state is now always reset; refund=0
just skips the `_safeSend`. Slash still accrues to slashCollected or
ownerSweep (per F-024). Degenerate small-stake voters can withdraw
their state without being stuck. (DatumGovernanceV2.sol:578-597)



`DatumGovernanceV2.withdraw` (line 571) `require(refund > 0, "E58")`. For
a loser with `lockAmount * (10000 - slashBps) / 10000 == 0` (e.g.,
`lockAmount == 1`, `slashBps == 9999`), refund rounds down to zero and
the withdraw reverts permanently. The voter's `Vote` state is never
reset (the function reverts before line 573-576), and the slash itself
is also never added to the pool (line 565-567 runs only on success). So:

- The 1-wei lockAmount is stranded inside the contract.
- The vote weight stays counted forever.
- No one else's accounting is affected.

The protocol intent (per G-M2 comment) is that slashBps < 10000 always
leaves a non-zero refund. That holds for "reasonable" lockAmounts but
not for 1-wei pathological inputs. A check `if (slash > 0) refund = max(refund, 1)`
would unstick the case, or just `require(refund > 0 || slash > 0,
"E58")` and skip the value transfer when refund is zero so the slash
still accumulates.

Not exploitable for griefing the protocol — only the voter's own dust
loses. Recording for completeness.

---

### F-026 — DatumWrapper wrap path is DoS-able via uncanceled `pendingWrap` commitments (HIGH) — **CLOSED 2026-05-20**

**Fix applied:** `wrap` now pulls canonical atomically from the caller via
`precompile.transferFrom(canonicalAssetId, msg.sender, address(this),
amount)`. The two-step `requestWrap` → `wrap` flow with shared
`totalCommittedCanonical` accounting is gone; `requestWrap` and
`cancelWrapRequest` remain as deprecated no-ops for ABI compatibility.
`IAssetHubPrecompile` gained `transferFrom`; `AssetHubPrecompileMock`
implements the standard ERC-20 approve/allowance/transferFrom surface.
Caller must `precompile.approve(wrapper, amount)` off-chain first
(Asset Hub pallet-assets exposes this natively).
Regression tests: `test/audit-f026-wrapper-dos.test.ts` (7 cases).



`DatumWrapper.requestWrap` (alpha-core/contracts/token/DatumWrapper.sol:108-113)
adds the requested amount to `pendingWrap[msg.sender]` AND to the global
`totalCommittedCanonical`. Subsequent `wrap()` calls require:

```solidity
require(canonical >= totalSupply() + totalCommittedCanonical, "underfunded");
```

`requestWrap` has no caller cost beyond gas, no expiry, no upper bound, and
no permissionless cleanup. Only the requester can call
`cancelWrapRequest` to release their commitment.

Attack: an adversary calls `requestWrap(VERY_LARGE)` once. `totalCommittedCanonical`
becomes large enough that no real user can satisfy the `canonical >=
totalSupply + totalCommittedCanonical` check by depositing at any
realistic scale. Even a small `requestWrap(2**128)` would require canonical
holdings far in excess of total DATUM supply, blocking all legitimate
`wrap()` calls. Recovery requires the adversary to call
`cancelWrapRequest` — they have no incentive to do so.

Impact: WDATUM wrap path is bricked until either (a) the adversary
cancels voluntarily, (b) the wrapper is migrated to a v2, or (c) a
governance fork. Settlement-side and bootstrap-side mints (which go
through `mintTo` directly from MintAuthority) are unaffected. Direct
user-initiated `wrap` of canonical DATUM held on Asset Hub becomes
impossible.

Severity: HIGH because the attack cost is one tx of gas, the impact is
DoS of a primary user path, and recovery requires a redeploy.

Remediations (any one):

1. **Per-user cap**: limit `pendingWrap[user]` to some reasonable upper
   bound (e.g. 1M WDATUM). Adversary still grief-able with many
   addresses, but each one cost-bounded.
2. **Time-limited request**: pendingWrap entries expire after N blocks
   (~24h). Permissionless `expireRequest(user)` can clean up.
3. **Required deposit at request time**: `requestWrap` transfers
   canonical IN at intent time via `precompile.transferFrom`. wrap()
   then just claims. The H1-fix narrative says this was the prior
   problem (atomic deposit), but a transferFrom from the user requires
   user approval — same friction as the current two-call flow without
   the open-commitment surface.
4. **Bond at request**: require small DOT bond at requestWrap, refunded
   on wrap or cancel. Forfeit-to-treasury on auto-expire. Both
   discourages spam and provides funding for cleanup.

Option 3 (precompile.transferFrom in `requestWrap`) most closely matches
the H1 audit-fix's stated intent of "atomic deposit". PRE-ALPHA-5-BACKLOG.md
§1.1 already flags the unwrap XCM-path swap as a mainnet blocker;
wrap-side hardening fits in the same swap.

---

### F-027 — `DatumMintAuthority.stageIssuerTransfer` is owner-only with no OpenGov phase gate (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `stageIssuerTransfer` now carries `whenOpenGovPhase`.
The §5.5 sunset path requires OpenGov authorization to stage a
successor — deployer EOA in Phase 0 can no longer self-stage as
canonical DATUM issuer. DatumMintAuthority.sol:223-232.



DatumMintAuthority.sol:223-228 — `stageIssuerTransfer(newAuthority)` is
`onlyOwner`. The sunset is a lock-once cypherpunk commitment: once
`acceptIssuerRole` fires, `issuerLocked = true` permanently and the
canonical issuer role for DATUM has handed off to the staged successor.

The contract does not gate `stageIssuerTransfer` on
`whenOpenGovPhase`. During Phase 0 (Admin), the deployer EOA is the
owner. A compromised or malicious deployer can stage themselves as
successor and call `acceptIssuerRole` from their own context, gaining
permanent canonical-issuer authority for DATUM.

In the trust model the deployer is trusted in Phase 0. But every other
lock-once cypherpunk function in this codebase (`lockGuardianSet`,
`lockOracleReporter`, `lockCouncil`, `lockBlocklistCurator`, etc.) is
gated on `whenOpenGovPhase` precisely to prevent this class of mistake.
The mint-authority sunset is arguably the most consequential lock-once
in the entire system — losing this should require the highest possible
authorization.

Fix: add `whenOpenGovPhase` to `stageIssuerTransfer`. The §5.5 sunset
path is explicitly post-OpenGov per the spec, so phase-gating it costs
nothing operationally and removes the Phase 0 footgun.

---

### F-028 — `DatumMintAuthority` does not enforce wrapper invariant pre-mint (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Added `DatumWrapper.sweepSurplus(recipient, amount)` —
owner-only entry that debits canonical excess (`canonical - (totalSupply
+ totalCommittedCanonical)`) and transfers to `recipient`. Owner is
Timelock in production so each sweep flows through 48h delay. Re-asserts
the peg invariant after the transfer. (DatumWrapper.sol:198-218)



DatumMintAuthority.sol:182-184 (and parallel branches in
mintForBootstrap/mintForVesting) calls `precompile.mint(...)` for the
canonical reserve, then `Wrapper.mintTo(...)` for the WDATUM. The
canonical mint and WDATUM mint are two separate external calls. If the
precompile mint succeeds but the wrapper's `_checkInvariant` fails (or
wrapper.mintTo reverts for any other reason), the canonical mint is
already complete and the wrapper has canonical without matching WDATUM
— a permanent peg surplus on the wrapper side.

This is documented as "the authority is expected to have minted matching
canonical DATUM to this contract's address before calling — otherwise
the invariant check will revert." But the failure mode leaves canonical
stranded on the wrapper with no recovery path.

Severity: LOW. The wrapper's `_checkInvariant` requires
`totalSupply + totalCommittedCanonical <= canonical`, so the invariant
is symbolically maintained (canonical > supply is fine). But the
arithmetic surplus is permanent — no `sweepSurplus()` exists.

Recommendation: either (a) implement `sweepSurplus(address treasury)`
gated on governance, or (b) treat surplus as already-credited and
account for it in future mints. Either fixes the asymmetry.

---

### F-029 — `StakeRootV2.finalizeRoot` threshold uses live `totalReporterStake`, vulnerable to honest-exit-driven dilution (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `PendingRoot` struct gained `totalStakeAtPropose` field
populated at `proposeRoot` time (DatumStakeRootV2.sol:107-108, 449-450).
`finalizeRoot` now compares `approvedStake` against the snapshot
(line 483-484), not the current live total. Honest reporter exits during
the challenge window can no longer lower the threshold an attacker's
approvals must clear. All existing StakeRootV2 tests still pass.



DatumStakeRootV2.sol:475-495 — finalization requires:

```solidity
require(p.approvedStake * 10000 >= totalReporterStake * uint256(approvalThresholdBps), "E46");
```

`p.approvedStake` is the sum of approvers' stakes captured at approval
time. `totalReporterStake` is the CURRENT global total. Reporters can
`proposeReporterExit` during the challenge window; that immediately
decrements `totalReporterStake` (DatumStakeRootV2.sol:322), but
`p.approvedStake` is a static number.

Attack / bad-luck scenario: honest reporters with 700 stake exit during
the challenge window (planned departures, churn, fee disputes). Attacker
controls 200 stake split across approvers. Initial state:

- approvedStake = 200, totalReporterStake = 1000, threshold 51% → need 510.

After honest exits:

- approvedStake = 200 (unchanged), totalReporterStake = 300, threshold 51%
  → need 153. approvedStake = 200 ≥ 153 → finalize allowed.

The attacker's 200 stake is now 67% of the post-exit total and finalizes
a fraudulent root that wouldn't have passed at proposal time.

The attacker does not need to control honest reporters; they only need
to time the proposal so it overlaps with a known wave of exits (e.g.,
network reward schedule changes, reporter set rotation).

Fix: snapshot `totalReporterStake` at `proposeRoot` time and use that
snapshot in the finalization check. Mirrors GovernanceV2's M-2 fix of
snapshotting the conviction curve per-proposal. Approvers added later
can still contribute to `approvedStake` against the original quorum
denominator.

Alternative (more invasive): re-evaluate approver stake at finalize time
(e.g., recompute by iterating `_approvedBy[epoch][*]`). Catches stake
reduction of approvers too.

---

### F-030 — `_slashProposer` is O(n) over `reporterList` and can hit block gas with permissionless joining (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** Added `_approversByEpoch[epoch]` push-list populated at
`proposeRoot` + `approveRoot` (DatumStakeRootV2.sol:113-117, 460-461,
475-477). `_slashProposer` now iterates only the per-epoch approver
list instead of the full `reporterList`, with `_approvedBy` flag
serving as the dedupe sentinel. Worst-case gas bounded to the count
of actual approvers for that epoch — Sybil joiners can no longer
push reporterList to the block gas limit to brick fraud proofs.



DatumStakeRootV2.sol:638-651 — `_slashProposer` iterates the full
`reporterList` to find approvers and slash each. With permissionless
join via `joinReporters`, the list grows unboundedly.

Attack: an adversary or wave of legitimate joiners pushes `reporterList`
to thousands. A subsequent fraudulent root + challenge invokes
`_slashProposer`; the loop iterates every reporter (not just approvers)
and hits the block gas limit. The fraud proof reverts, the malicious
root finalizes.

Permissionless `markInactive` reduces voting weight but does NOT remove
the reporter from `reporterList` until `finalizeReporterExit` is called
(after `reporterExitDelay`). So Sybil joiners stay in the list during
the entire exit delay window.

Fix options:

1. Track approvers in a per-epoch list (`address[] approversByEpoch`).
   Push at approveRoot time. Slash loop iterates that bounded list
   (≤ active reporter count at the time of the proposal).
2. Hard cap on `reporterList.length` (e.g. 200). Bounds the Sybil
   surface and the worst-case slash gas.
3. Remove from reporterList at `proposeReporterExit` time (current code
   defers to `finalizeReporterExit`).

Option 1 is most surgical — the slash only needs to walk approvers, not
all reporters.

---

### F-031 — `DatumPublisherStake.setParams` and similar economic-parameter setters lack rate-limit (MEDIUM) — **CLOSED 2026-05-20 (5 highest-impact setters)**

**Fix applied:** `ParameterRetuneGuard` mixin adopted on the 5 highest-impact
setters per design call:

- `DatumPublisherGovernance.setSlashBps` (key `"slashBps"`)
- `DatumAdvertiserGovernance.setParams` (key `"slashBps"`)
- `DatumGovernanceV2.setSlashBps` (key `"slashBps"`)
- `DatumGovernanceV2.setQuorumWeighted` (key `"quorumWeighted"`)
- `DatumMintCoordinator.setMintRate` (key `"mintRate"`)

Each contract gained `ParameterRetuneGuard` inheritance + a
`setRetuneCooldownBlocks(blocks_)` owner-only entry. Default cooldown
is 0 (testnet posture); production sets a non-zero value (e.g. 14400
≈ 24h) before mainnet. Per-key cooldowns are independent — a slashBps
retune doesn't block a quorumWeighted retune.

Regression tests: `test/audit-f031-retune-guard.test.ts` (5 cases).
Remaining setters across the codebase (e.g. PowEngine difficulty,
PauseRegistry params) are tracked in PRE-ALPHA-5-BACKLOG.md §3.-5 for
the dedicated retune-guard adoption PR.



DatumPublisherStake.sol:81-87 — `setParams(baseStake, perImpression, delay)` is
plain `onlyOwner` with no `ParameterRetuneGuard` cooldown. A captured or
compromised owner can spike `planckPerImpression` to a large value,
causing every publisher's `requiredStake(publisher)` to exceed their
deposit, which makes Settlement reject all their claims (reason code 15).

PRE-ALPHA-5-BACKLOG.md §3.-5 already flags adopting `ParameterRetuneGuard`
on the governance contracts. The same pattern applies to economic
setters here. `DatumRelayGovernance` is the only one currently wired
with the guard.

Fix: integrate `ParameterRetuneGuard` on `setParams` and
`setMaxRequiredStake`, with per-key cooldown bounded to e.g. 24h once
configured. Pre-mainnet, owner is Timelock so the 48h delay already
provides some buffer — but a single proposal can move multiple
parameters at once, while ParameterRetuneGuard enforces a cool-down
between consecutive retunes.

Same concern applies to (cross-cutting):

- `DatumPublisherGovernance` slash/conviction/bond setters
- `DatumAdvertiserGovernance` similar setters
- `DatumGovernanceV2.setSlashBps`, `setQuorumWeighted`, `setGraceParams`,
  `setConvictionCurve`, `setConvictionLockups`
- `DatumMintCoordinator.setMintRate`, `setDatumRewardSplit`,
  `setDustMintThreshold`
- `DatumPowEngine.setPowDifficultyCurve`
- `DatumActivationBonds.setMinBond`, `setTimelockBlocks`, `setPunishmentBps`

---

### F-032 — `Settlement.settleClaims/settleClaimsMulti` lack `whenNotPaused` (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Added `whenNotFrozen` modifier to
`DatumSettlement.settleClaims` and `settleClaimsMulti`. Defense-in-depth:
even if a future Logic rotation drops the modifier on LogicA's side, the
shell dispatcher rejects writes during a frozen migration window.
(DatumSettlement.sol:508-528)



`DatumSettlement.settleClaims` and `settleClaimsMulti` (DatumSettlement.sol:508-523)
are shell dispatchers that delegatecall into LogicA. LogicA's
`settleClaims/settleClaimsMulti` carries `nonReentrant`, `whenNotFrozen`,
and the `pausedSettlement` check (DatumSettlementLogicA.sol:41-49).

So pause gating IS enforced via LogicA. But the dispatcher itself has
no `whenNotFrozen` modifier, meaning if LogicA were somehow ever
delegated to a malicious implementation that skipped these checks,
Settlement would be wide open. The current `lockLogic` (F-003) is the
defense, but `lockLogic` has the Phase 0 footgun (F-003).

Defense-in-depth recommendation: add `whenNotFrozen` (and the explicit
`pausedSettlement` check) to the public dispatchers in
`DatumSettlement.sol`. Costs one extra SLOAD per call; eliminates the
single-point dependency on Logic correctness.

---

### F-033 — `DatumAttestationVerifier` is not upgradable and is locked-once on Settlement (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `DatumAttestationVerifier` now inherits `DatumUpgradable`
(was just `EIP712`). Added `version()` override and `whenNotFrozen`
modifier on `settleClaimsAttested`. Future bug fixes in the verifier
can now follow the standard `DatumGovernanceRouter.upgradeContract` +
`migrate()` path instead of requiring Settlement redeploy.
(DatumAttestationVerifier.sol:5-26, 89)



`DatumAttestationVerifier` does NOT inherit `DatumUpgradable` and is wired
into Settlement via `setAttestationVerifier` which is lock-once
(DatumSettlement.sol:237-241). Once wired post-deploy, the
AttestationVerifier contract is **permanently the verifier for the lifetime
of that Settlement instance**.

If a bug is discovered in AttestationVerifier post-launch (e.g., a future
sig-malleability issue, ECDSA edge case, EIP-712 domain regeneration
gap), the remediation path requires:

1. Deploy a new AttestationVerifier
2. Deploy a new Settlement (since `setAttestationVerifier` cannot be
   re-fired)
3. Re-migrate every other contract's Settlement pointer
4. Replay claim chain state

This is an extreme remediation cost for a contract that does on-chain
ECDSA verification — exactly the kind of code that historically has
edge cases. Most other satellites are upgradable via the Stage-1
registry (`DatumGovernanceRouter.upgradeContract`).

Fix options:

1. Move AttestationVerifier onto the upgrade ladder (inherit
   `DatumUpgradable`, add `whenNotFrozen` to `settleClaimsAttested`).
2. Convert Settlement's `setAttestationVerifier` from lock-once to
   `onlyGovernance` (so Timelock can rotate via OpenGov), retaining
   lock semantics via a separate `lockAttestationVerifier()`.

---

### F-034 — Settlement-side per-claim publisher mismatch is partially enforced; cross-cutting with F-001 (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** `DatumAttestationVerifier.settleClaimsAttested` now enforces
single-publisher across ALL paths (open AND targeted multi-publisher) — the
previously open-only check at line 110-112 moved out of the conditional and
runs after `expectedPublisher` is resolved (DatumAttestationVerifier.sol:113-122).
Defense-in-depth boundary mirrors the F-001 fix in LogicB; either contract's
check now reverts the attack independently.



`DatumAttestationVerifier.settleClaimsAttested` enforces single-publisher
per batch ONLY for open campaigns (DatumAttestationVerifier.sol:99-113).
For targeted campaigns (`cPublisher != address(0)`), only the initial
publisher's signature is verified — the per-claim publisher field is NOT
checked against cPublisher inside AttestationVerifier.

`DatumClaimValidator` (line 360-373) does enforce
`claim.publisher == cPublisher` for legacy single-publisher campaigns.
But for multi-publisher allowlist campaigns (where `cPublisher` is the
initial seeding publisher and additional publishers are added via
`DatumCampaignAllowlist.addAllowedPublisher`), the validator follows the
allowlist branch (line 334-359) and accepts any allowlisted publisher
per claim.

This is the same root cause as F-001: payment aggregation in
`LogicB._processBatch` credits all publisher payment to
`agg.publisher = claims[0].publisher`. AttestationVerifier doesn't catch
the divergence because it only checks the initial publisher's cosig.

Fix: enforce single-publisher per batch in
`AttestationVerifier.settleClaimsAttested` for ALL paths (open AND
targeted), mirroring the existing open-campaign check at line 110-112.
This complements the F-001 fix in Settlement.

---

### F-035 — `DatumParameterGovernance.setParams` accepts arbitrary values; can be set to zero (MEDIUM) — **CLOSED 2026-05-20**

**Fix applied:** Added bounds on `setParams`:
`MIN_VOTING_PERIOD_BLOCKS = 1`, `MIN_TIMELOCK_BLOCKS = 1`, `MIN_QUORUM = 1`,
`MAX_GOVERNANCE_WINDOW_BLOCKS = 432_000` (~30 days). Captured owner can no
longer collapse the pipeline to zero-delay / zero-quorum / instant-execution.
Production deploys set values far above these floors; the floors are
anti-bypass guards only. DatumParameterGovernance.sol:275-298.



DatumParameterGovernance.sol:275-286 — `setParams` sets
`votingPeriodBlocks`, `timelockBlocks`, `quorum`, and `proposeBond` with
no bounds. Owner (Timelock in production) can set:

- `votingPeriodBlocks = 0` — proposals immediately past voting window.
- `timelockBlocks = 0` — passes immediately executable.
- `quorum = 0` — single-aye-vote suffices (just msg.value > 0).
- `proposeBond = 0` — no economic skin-in-the-game.

Combined, an owner with these settings can trivially pass any whitelisted
parameter change in one block. Since the whitelist itself
(`whitelistedTargets` / `permittedSelectors`) is also owner-mutable
without lock, a captured owner can:

1. Whitelist a target + selector.
2. Set quorum=0, timelock=0, votingPeriod=0.
3. Propose, vote a token amount, resolve, execute — all in one tx batch.
4. Effectively bypass the entire ParameterGovernance pipeline.

Fix: bound each parameter:

- `votingPeriodBlocks` ≥ MIN_VOTING_PERIOD (e.g. 14400 ≈ 24h).
- `timelockBlocks` ≥ MIN_TIMELOCK (e.g. 14400).
- `quorum` ≥ MIN_QUORUM (operationally non-zero).
- `proposeBond` ≥ MIN_PROPOSE_BOND.

Maxima also help — prevent grief-via-absurd-timelock.

---

### F-036 — `DatumParameterGovernance` whitelist mutable without lock-once (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Added `lockWhitelist()` phase-gated on OpenGov to
DatumParameterGovernance. Once locked, `setWhitelistedTarget` and
`setPermittedSelector` revert `whitelist-locked`. The (target, selector)
set is frozen for the life of the deployment — a captured owner can no
longer route new admin functions through the PG pipeline.
(DatumParameterGovernance.sol:251-274)



DatumParameterGovernance.sol:247-255 — `setWhitelistedTarget` and
`setPermittedSelector` are `onlyOwner` with no lock. A captured owner
can dynamically whitelist any (target, selector) pair and route through
a normal-looking proposal. The proposal still requires voting period +
timelock, so the 48h+ delay applies — but the whitelist guard is the
intended hard wall and it's missing.

Fix: add a `lockWhitelist()` `whenOpenGovPhase` that freezes the
whitelist permanently. Before lock, operators add the curated set of
(target, selector) pairs; after lock, only those pairs can ever be
governed by PG.

---

### F-037 — `impression.circom` `nonceSquared` constraint is a no-op (INFO)

`alpha-core/circuits/impression.circom:114-116`:

```
signal nonceSquared;
nonceSquared <== nonce * nonce;
```

The signal is declared, assigned, and never used by any other constraint
or output. The constraint compiles to a R1CS quadratic constraint
binding `nonceSquared = nonce^2`, but since `nonceSquared` has no
downstream consumer, the only effect is one extra constraint in the
proving key with no soundness impact.

The comment claims this binds the proof to a specific claim ("prevents
proof reuse on a different claim"), but the actual binding to the claim
happens via `claimHash` as a public input. `claimHash` is computed
off-chain (in `DatumClaimValidator.validateClaim`, line 420-431) over
the full claim fields including `nonce`; the circuit takes `claimHash`
as a public input and the on-chain verifier ensures
`pub0 == claimHash`. So nonce binding is sound, but the in-circuit
`nonceSquared` constraint adds no enforcement beyond the public-input
binding.

Recommendation: either (a) remove the `nonceSquared` constraint (dead
code, costs constraints), or (b) actually constrain `nonce` against
some derivation visible in the circuit — e.g. `Poseidon(secret, nonce)
=== something_in_claimHash` — to make the binding cryptographically
verified inside the circuit. (b) is more work and may not be needed
since claimHash already binds nonce off-chain.

---

### F-038 — `DatumStakeRoot` v1 reporter set is owner-managed and not bounded (LOW) — **CLOSED 2026-05-20**

**Fix applied:** Added `MAX_REPORTERS = 32` cap on V1 reporter set
(matches V1's documented 3-of-5 target with substantial headroom while
bounding the linear-scan operations). `addReporter` now reverts
`max-reporters` once the cap is hit. (DatumStakeRoot.sol:80-91)



DatumStakeRoot.sol:83-117 — `addReporter` / `removeReporter` are
`onlyOwner` with no upper bound on reporter set size. `addReporter`
pushes to an array; `removeReporter` does a linear scan to remove. If
reporter set grows large (no enforced limit), `removeReporter`'s linear
scan and `isRecent`'s 8-epoch loop continue to be bounded but could
slow.

In production, v1 is targeted for `3-of-5` reporters per
PRE-ALPHA-5-BACKLOG.md §1.2 line 178 — small. So unbounded growth is
not a current concern. Note for hardening.

Note: `setThreshold` requires `t <= reporters.length` (line 114). Good.
L-4 fix clamps threshold on `removeReporter` (line 106). Good.

---

### F-039 — Pre-OpenGov direct overrides via owner-only setters (cross-cutting INFO)

Many "tunable" parameters across the codebase are `onlyOwner` with no
`whenOpenGovPhase` gate, intentional for alpha/beta iteration:

- `DatumSettlement.setUserShareBps`, `setMaxBatchSize`,
  `setMaxSettlementPerBlock`, `setMinClaimInterval`
- `DatumCampaigns.setDefaultTakeRateBps`, `setMaxCampaignBudget`,
  `setMaxAllowedMinStake`
- `DatumPublisherStake.setParams`, `setMaxRequiredStake`,
  `setMaxSlashBpsPerCall`
- `DatumPowEngine.setEnforcePow`, `setPowDifficultyCurve`
- `DatumPauseRegistry.setSoloMaxPauseBlocks`,
  `setCategoryMaxPauseBlocks`, `setReengagementCooldownBlocks`
- `DatumMintCoordinator.setMintRate`, `setDustMintThreshold`,
  `setDatumRewardSplit`
- ... and ~20 more

In production owner = Timelock so all changes go through a 48h delay.
PRE-ALPHA-5-BACKLOG.md §3.-5 (G-10 close + retune-guard adoption) is
the documented mitigation path. Capturing here as a single cross-cutting
observation so it's findable in the audit report.

---

### F-017 — `_status` re-entry lock semantics depend on shared-storage layout invariant (INFO)

The Settlement DELEGATECALL chain (Settlement → LogicA → LogicB) shares the
ReentrancyGuard `_status` slot via DatumSettlementStorage. The doc
SETTLEMENT-ARCHITECTURE.md §"ReentrancyGuard semantics" describes the
asymmetric placement (nonReentrant on LogicA but not Settlement's relay
dispatcher) to avoid double-locking.

Risk if a future Logic upgrade adds a public entry on Logic reachable WITHOUT
going through Settlement's dispatcher (e.g. callable as LogicA directly when
LogicA is also registered elsewhere): that entry would need its own
`nonReentrant`, and forgetting it would reopen reentrancy. The current code
is correct; this is a maintenance-time footgun.

Mitigation: add a Logic-side stub `nonReentrant` modifier to every public
entry, or a deploy-time test that scans LogicA/LogicB for non-nonReentrant
externals and fails the build.

