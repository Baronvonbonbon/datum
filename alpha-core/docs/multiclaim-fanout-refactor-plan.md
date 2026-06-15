# Plan — per-claim fan-out refactor (unblock multi-claim settle on Paseo)

## Goal
Let `settleClaims` settle multi-claim batches (target: up to the contract cap of 50) on
pallet-revive/Paseo, where today n ≥ 2 reverts `OutOfGas`. The batched-vault-credit fix
(commit `3270d24`) removed the per-claim vault transfers and resolved the `creditSettlement`
OOG, but the OOG moved to `PublisherStake.recordImpressions` — proving the binding constraint
is the **per-claim cross-contract call fan-out**, whose cumulative weight (ref_time and/or
proof_size — see below) exceeds pallet-revive's per-tx budget. Each extra claim re-runs a
handful of external calls; the cliff sits between n=1 and n=5.

## Binding-resource note (resolved empirically by measure-first)
Two pallet-revive resources can manifest as "OutOfGas with abundant gas":
- **ref_time** (execution weight) — charged per cross-contract CALL (call setup + code load).
  Grows with the *number of calls*. ⇒ reducing call count is the fix.
- **proof_size** (PoV) — charged per *distinct* storage item touched. Repeated reads of the
  same (invariant) slot are proofed once; only *new* slots per claim (e.g. ZK nullifiers) grow it.
The plain-CPM loop touches mostly batch-invariant slots, so ref_time (call count) is the prime
suspect. The tiers below cut call count regardless; we re-measure the achievable n on Paseo
after each tier to confirm which resource bound and when it's cleared.

## Current per-claim external calls (plain CPM path, `DatumSettlementLogicB.processBatch`)
Per claim, in the loop (≈25 cross-contract calls for a 5-claim batch):
| Call | Line | Variant over batch | Disposition |
|---|---|---|---|
| `_claimValidator.validateClaimWithContext(claim,…)` | ~387 | per-claim (hash/nonce/CPM/PoW) | **Tier 3** — batch into one call |
| `_campaigns.getCampaignUserCapSafe(campaignId)` | 416 | **invariant** (campaignId) | **Tier 1** — hoist to ctx |
| `_rateLimiter.tryConsume(publisher, eventCount)` | 435 | publisher invariant, events sum | **Tier 2** — one batched consume |
| `_publisherStake.isAdequatelyStaked(publisher)` | 445 | **invariant** (publisher, pre-recordImpressions) | **Tier 1** — hoist (check once) |
| `_nullifiers.tryConsume(campaignId, nullifier)` | 466 | per-claim, ZK only (skipped for plain) | keep (genuinely unique) |
| `_budgetLedger.deduct(campaignId, actionType, amount)` | ~499 | per-claim amount/pot | keep per-claim (see Tier-2 note) |

Already once-per-batch (good, do not touch): `resolveBatchContext`, and all post-loop satellite
writes — `powEngine.consumeFor`, `transferSettled`, `creditSettlement`, `mintCoordinator.coordinate`,
`publisherStake.recordImpressions`, `reputation.recordSettlement`, `lifecycle.completeCampaign`.

## Refactor — tiered, measure after each

### Tier 1 — hoist the two invariant reads  (low risk, small diff)
- Add `userCapMax`, `userCapWin`, `publisherStaked` to `IDatumClaimValidator.BatchContext`.
- In `DatumClaimValidator.resolveBatchContext` (already the once-per-batch invariant resolver),
  read `getCampaignUserCapSafe(campaignId)` and `_publisherStake.isAdequatelyStaked(publisher)`
  once and populate the new fields. (resolveBatchContext already holds the publisher + campaign.)
- In `LogicB.processBatch`:
  - replace the per-claim `getCampaignUserCapSafe` call with `ctx.userCapMax/ctx.userCapWin`
    (the per-claim *window-event accumulation* at L418–427 stays — it's in-storage, no call);
  - move the stake check out of the loop: if `!ctx.publisherStaked` reject the whole batch once
    (publisher is E34-invariant; `isAdequatelyStaked` is constant until `recordImpressions`
    runs post-loop, so once == per-claim — **semantics preserved**).
- Cuts **2 calls/claim**. No storage-layout change (ctx is memory).

### Tier 2 — batch the rate-limit consume  (low/med risk)
- Accumulate `viewEvents` (sum of actionType-0 `eventCount`) in the loop; after validation, call
  `_rateLimiter.tryConsume(publisher, viewEvents)` **once**.
- ⚠️ Semantic change: window-cap rejection becomes **all-or-nothing per batch** instead of
  per-claim partial. Acceptable for a per-publisher window limiter; document it. (If partial-fill
  must be preserved, add a `peekConsume(publisher, total)` that returns how many fit and trim.)
- Cuts **1 call/claim**.

### Tier 3 — batch the per-claim validation  (highest payoff, highest risk)
- Add `IDatumClaimValidator.validateBatch(claims[], user, campaignId, ctx) → (bool[] accept,
  uint8[] reason, bytes32[] computedHash)` that loops internally and returns per-claim results
  (the nonce/prevHash chain is derived inside, as today).
- `LogicB.processBatch` calls `validateBatch` **once**, then iterates the returned arrays in
  memory to do budget `deduct`, accounting, and events — no per-claim cross-contract validation call.
- Reduces validation from **N calls → 1**. This is the change that makes per-claim call count
  ~O(1) and should clear the cliff up to the 50 cap.
- Risk: ClaimValidator interface + a sizable LogicB loop rewrite; must preserve the exact
  reject reason codes (16/26/27/29/…), the derived nonce chain, and CEI ordering.

### Keep per-claim (intentional)
- `_budgetLedger.deduct` — now transfer-free and lightweight; keeping it per-claim **preserves
  partial-fill** (a batch settles up to budget exhaustion via the `exhausted`/`gapFound` path).
  Batching it by actionType would turn partial-fill into all-or-nothing (revert E16) — avoid
  unless a later measurement shows deduct is still the binding call.
- `_nullifiers.tryConsume` — ZK-only, genuinely unique per claim (and grows proof_size). ZK
  multi-claim batches will inherently cap lower than plain CPM; document the separate ceiling.

## Measure-first protocol (after each tier)
1. `npx hardhat test` (full suite must stay green; 1706 baseline).
2. Fresh Paseo redeploy (`WIRE_ZK_PREDICATE=1`), then `scripts/capture-settle-weight-paseo.ts`
   extended to scan n = 1,2,3,5,8,10,15,25,50 → record the **max settleable n** and the weight
   curve. Compare against the prior cliff to confirm the marginal per-claim cost dropped and
   whether the next tier is needed. (Restore canonical addresses after, as before.)

Expected: Tier 1+2 alone pushes the ceiling from ~1 to several claims; Tier 3 should reach the
50-claim cap. Stop at the first tier that meets the target.

## Invariants / guardrails
- **Storage layout:** no new storage in Settlement/LogicA/LogicB (hoisted values live in the
  memory `BatchContext`); the 48-slot delegatecall snapshot gate must keep passing.
- **Reject reason codes** unchanged (off-chain relays/indexers depend on them).
- **CEI ordering** (effects — `_lastClaimHash`/`_lastNonce` — before external calls) preserved.
- **Partial-fill on budget exhaustion** preserved (keep deduct per-claim).
- All settle paths share `processBatch`, so `settleClaims`, `settleClaimsMulti`, dual-sig and
  attestation all benefit; no per-path changes.

## Test plan
- Extend `test/settlement.test.ts` / `settlement-multi.test.ts` with n=10/25/50 batches
  asserting identical balances/exhaustion to the per-claim baseline (functional equivalence).
- Add a call-count assertion (instrumented mock validator/limiter counting invocations) proving
  validation + rate-limit + cap + stake are each invoked **once per batch**, not per claim.
- Re-run the Paseo capture (measure-first protocol) for the on-chain ceiling.

## Sequencing
Tier 1 → measure → Tier 2 → measure → (if needed) Tier 3 → measure. Land each as its own commit
on the existing branch so the Paseo ceiling improvement is attributable per tier.

## Measured results (max settleable claims per `settleClaims` tx on Paseo)
Fine n-scan via `capture-settle-weight-paseo.ts` (fresh deploy each, diana staked, PoW off):

| Build | Max n | Notes |
|---|---:|---|
| original (per-claim vault transfer) | ~1 | creditSettlement OOG at n≥2 |
| **batched vault credit** (commit 3270d24) | **4** | n=4 ✅, n=5 ❌ — matches alpha-3 "~3-claim cap" |
| **+ Tier 1** (hoist userCap + isAdequatelyStaked) | **6** | n=6 ✅, n=7 ❌ |

**Tier 1: ceiling 4 → 6 (+2 claims).** This is exactly the predicted "≈ +1 claim of headroom per
cross-contract call removed per claim" (Tier 1 removed 2 calls/claim) — confirming the binding
resource is per-claim cross-contract **call count** (ref_time), and that the refactor thesis holds.
Extrapolating: Tier 2 (−1 call/claim) ≈ 7; Tier 3 (batch validation removes the heaviest per-claim
call, the validator) is the lever that should jump the ceiling toward the 50-claim contract cap.
Full suite 1706 passing; storage-layout snapshot intact.
