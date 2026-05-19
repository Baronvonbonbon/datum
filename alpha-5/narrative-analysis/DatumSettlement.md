# DatumSettlement

The protocol's bottleneck — every claim becomes a payment here, or it
doesn't. Settlement reads claims, validates them via
`DatumClaimValidator`, decides who gets paid what, deducts from
`DatumBudgetLedger`, and credits earnings to `DatumPaymentVault`.
Optionally mints DATUM via `DatumMintCoordinator`, credits ERC-20
side-rewards via `DatumTokenRewardVault`, updates publisher
reputation via `DatumPublisherReputation`, and advances the publisher
+ advertiser stake bonding curves.

It is also where most of the protocol's adversarial defenses live in
one place: the AssuranceLevel gate, the per-user / per-publisher
rate limits, the leaky-bucket PoW, the nullifier registry, the user
self-pause / blocklist, and the global per-block circuit breaker.

This document is the entry point for the **Settlement family**:

- [`DatumSettlementStorage.md`](./DatumSettlementStorage.md) — the
  shared storage base (slots, helpers, errors)
- [`DatumSettlementLogicA.md`](./DatumSettlementLogicA.md) — relay-
  path outer loops + per-batch auth
- [`DatumSettlementLogicB.md`](./DatumSettlementLogicB.md) —
  `_processBatch` inner pipeline
- [`DatumDualSigSettlement.md`](./DatumDualSigSettlement.md) — the
  EIP-712 dual-sig path (carve-out)

## Architecture: thin shell + two Logic contracts

Pre-alpha-4 hardening Settlement was a single monolithic contract.
After audit hardening it was ~40 KB of runtime bytecode — well over
EIP-170's 24,576 B cap. Paseo's pallet-revive doesn't enforce the
cap; mainnet EVM does.

The fix (phase 8d, 2026-05-19) was a **two-Logic split via DELEGATECALL**:

```
                      ┌────────────────────────┐
                      │  DatumSettlement (10K) │  ← thin shell + public ABI
                      │  - constructor wiring  │
                      │  - storage base        │
                      │  - external entries    │
                      └───────────┬────────────┘
                                  │ DELEGATECALL
                          ┌───────┴────────┐
                          ▼                ▼
                ┌────────────────┐  ┌──────────────────┐
                │  LogicA (3K)   │  │  LogicB (22K)    │
                │  - settleClaims│  │  - processBatch  │
                │  - settleMulti │  │  - inner pipeline│
                └───────┬────────┘  └──────────────────┘
                        │ chained DELEGATECALL
                        ▼
                  (same LogicB)
```

All three contracts inherit `DatumSettlementStorage` so they share
an identical storage layout. SLOAD/SSTORE in any DELEGATECALL frame
hit Settlement's slots. `msg.sender` propagates unchanged through
the chain — verified by `test/settlement-msgsender.test.ts`
(audit-hedge #2).

## Three settlement paths

1. **`settleClaims(ClaimBatch[])`** — Settlement → LogicA outer loop
   → LogicB per-batch. Authorized callers: the user themselves,
   `DatumRelay`, `DatumAttestationVerifier`, or the publisher's
   `relaySigner` hot key. Satisfies AssuranceLevel ≤ 1.
2. **`settleClaimsMulti(UserClaimBatch[])`** — same path but with
   nested loops for many users × many campaigns in one tx.
3. **`settleSignedClaims(SignedClaimBatch[])`** — carved out to
   `DatumDualSigSettlement` (alpha-4 EIP-170). Verifies EIP-712
   publisher + advertiser cosigs over `ClaimBatch(user, campaignId,
   claimsHash, deadline, expectedRelaySigner,
   expectedAdvertiserRelaySigner)` on the `DatumSettlement` EIP-712
   domain, then calls Settlement's `processVerifiedBatch` →
   DELEGATECALL into LogicB. Only path that satisfies AssuranceLevel
   = 2. Relay-key rotations on either side invalidate in-flight
   cosigs (A1 + M6 anti-staleness; audit pass 4).

## The `_processBatch` inner pipeline

Lives in LogicB. Order of checks (rejection reason codes in
parentheses):

1. **Batch caps** — `claims.length <= _maxBatchSize` else revert.
2. **User self-pause** (27, CB2) — `userPaused[user]` rejects the
   whole batch.
3. **User advertiser blocklist** (28, CB1) — user blocks campaign's
   advertiser → reject wholesale.
4. **User L3 ZK-only floor** (26, M1-fix) — `userMinAssurance[user]
   >= 3` requires `campaign.requiresZkProof == true`.
5. **People Chain identity gate** (30) — `effMinId = max(campaign.minIdentityLevel,
   userMinIdentityLevel)`. If non-zero, `identityRegistry.isVerified(user,
   effMinId)` must be true. Fail-CLOSED on revert.
6. **AssuranceLevel gate** (24/25) — pure helper
   `_assuranceDecision(campaignLevel, userFloor, advertiserConsented,
   fromRelay, fromPublisherRelay)`. Lifted to storage base for
   audit-hedge #5 table testing.
7. **BM-10 min claim interval** (18) — `block.number <
   lastSettlementBlock + interval` rejects.
8. **Reputation pre-gate** (20) — `_reputation.canSettle(publisher)`.

Per-claim loop:

9. **Same-campaign** (0) — `claim.campaignId == batch.campaignId`.
10. **Gap propagation** (1) — once `gapFound`, every subsequent
    claim rejects.
11. **Publisher blocklist** (11) — M2-fix + H-3 gradient: at
    `effectiveLevel >= 1`, `isBlockedStrict` fail-CLOSED; at L0,
    `isBlocked` fail-OPEN (liveness preference).
12. **User per-claim publisher block** (28).
13. **ClaimValidator.validateClaim** — hash chain, nonce, PoW, ZK.
    Reason 7 sets `gapFound`.
14. **MAX_USER_EVENTS cap** (13) — `_userCampaignSettled +
    eventCount <= 100,000`.
15. **Per-window cap** (29) — `Campaigns.getCampaignUserCapSafe`
    + window math.
16. **Rate limiter** (14) — `_rateLimiter.tryConsume(publisher,
    events)`. Atomic.
17. **Publisher stake adequacy** (15) — `_publisherStake.isAdequatelyStaked`.
18. **Nullifier consume** (19) — `_nullifiers.tryConsume(campaignId,
    nullifier)`. Atomic.

CEI effects (chain state before external calls): `_lastClaimHash`,
`_lastNonce`, ClickRegistry mark (CPC), payment math, BudgetLedger
deduction, aggregator accumulation.

Post-loop external calls: PoW bucket consume → L-7 circuit breaker
→ PaymentVault credit → MintCoordinator emission → TokenRewardVault
credit (fail-soft) → PublisherStake / AdvertiserStake (fail-soft)
→ PublisherReputation record → Lifecycle auto-complete on exhausted
→ BM-10 last-block update.

Every try/catch carries a `// SAFETY:` annotation naming the
gradient rule and the consequence of the opposite choice
(audit-hedge #9).

## The payment formula

```
totalPayment   = (ratePlanck × eventCount) / 1000   (view, actionType 0)
               = ratePlanck × eventCount             (click 1, action 2)

publisherPayment = totalPayment × cTakeRate / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder × userShareBps / 10000   (default 7500 = 75%)
protocolFee      = remainder - userPayment
```

`userShareBps` is bounded to `[5000, 9000]` by `setUserShareBps`.
`cTakeRate` is the per-claim take rate returned by
`ClaimValidator.validateClaim` (snapshotted at campaign / allowlist
creation — see `DatumCampaignAllowlist.md`).

## AssuranceLevel gradient

`_assuranceDecision` is the pure helper (audit-hedge #5):

| Effective Level | Path required | Reject reason |
|---|---|---|
| 0 | Any path accepts | — |
| 1 | Relay OR publisher's relaySigner OR advertiserConsented | 25 |
| 2 | Dual-sig (advertiserConsented == true) | 24 |
| 3+ | Dual-sig + user-side ZK required (M1-fix on caller) | 26 |

`effectiveLevel = max(campaignLevel, userMinAssurance)` — the user
can demand higher than the campaign offers; the campaign can't
demand lower than the user's floor. Dual-sig satisfies every level
by definition: both parties have signed off-chain.

## Fail-closed safe getters

Campaigns getters consumed in the hot path (`getCampaignAssuranceLevel`,
`getCampaignAdvertiser`, `getCampaignMinIdentityLevel`,
`getCampaignRequiresZkProof`, `getCampaignUserCap`,
`getCampaignRewardToken`, `getCampaignRewardPerImpression`) all have
non-reverting `*Safe` variants that return `(bool ok, value)`. The
hot path uses these (audit-hedge #4 / PRE-REDEPLOY H2-fix) so a
captured Campaigns upgrade can't selectively revert a getter to
silently downgrade L2 → L0 for targeted users.

## DATUM mint orchestration

Carved out to [`DatumMintCoordinator.md`](./DatumMintCoordinator.md)
(alpha-4 EIP-170). Settlement calls
`mintCoordinator.coordinate(user, publisher, advertiser, dotPaid)`
once per batch with the aggregated total. The coordinator owns the
mint authority pointer, the dust gate, the per-actor split bps
(default 55/40/5), and the Path-H emission engine integration. The
whole flow is wrapped in try/catch — a mint failure emits
`DatumMintFailed` but never reverts settlement.

## Settlement satellites

Each carved out for EIP-170; each independently upgradable:

- [`DatumSettlementRateLimiter.md`](./DatumSettlementRateLimiter.md)
  — BM-5 per-publisher window cap
- [`DatumNullifierRegistry.md`](./DatumNullifierRegistry.md) — FP-5
  ZK replay prevention
- [`DatumPublisherReputation.md`](./DatumPublisherReputation.md) —
  acceptance-rate counters + anomaly detection
- [`DatumPowEngine.md`](./DatumPowEngine.md) — per-impression PoW
  + leaky-bucket difficulty

Each is settable via Settlement's `set*` family; `address(0)` for
any satellite disables that gate path (acceptable for early Paseo,
not for mainnet).

## Lock-once references

Every structural reference (budgetLedger, paymentVault, lifecycle,
relay, claimValidator, attestationVerifier, publishers,
tokenRewardVault, campaigns, publisherStake, advertiserStake,
clickRegistry, mintCoordinator, rateLimiter, nullifiers, reputation,
powEngine, identityRegistry, dualSig, logicA, logicB) is settable
exactly once via its setter. Plus the global `_logicLocked` flag
(audit-hedge #3) gated on `whenOpenGovPhase` — once governance fires
`lockLogic()`, the LogicA + LogicB pair is frozen forever.

## Storage layout snapshot

`settlement-layout.snapshot.json` is committed alongside the
contract. `test/settlement-layout.test.ts` compares the current
layout against the snapshot on every CI run.
`scripts/deploy.ts` runs the same check before any contract is
deployed via `validateSettlementLayoutMatchesSnapshot()`
(audit-hedge #1). Any storage-layout drift in the family is a
deploy-time revert.

## Cap and rate-limit knobs (governance-tunable)

- **`_maxBatchSize`** (default 50, ceiling `MAX_BATCH_SIZE_CEILING =
  200`) — applies to both relay-path outer loops and dual-sig outer
  arrays.
- **`_minClaimInterval`** — minimum blocks between batches per
  (user, campaign, actionType). Default 0 (disabled).
- **`_maxSettlementPerBlock`** — L-7 global circuit breaker. 0 =
  disabled.
- **`_userShareBps`** — economic knob, [5000, 9000].

Rate limiter / nullifier registry / reputation / PoW knobs live on
their respective satellite contracts now.

## User-sovereignty knobs

- **`userMinAssurance`** — per-user floor on AssuranceLevel (max L3
  for ZK-only).
- **`userMinIdentityLevel`** — per-user floor on People Chain
  identity level.
- **`userBlocksPublisher`** — per-user publisher blocklist.
- **`userBlocksAdvertiser`** — per-user advertiser blocklist.
- **`userPaused`** — per-user kill switch (rejects all settlements
  on the user's account).

Each has its own setter on Settlement, callable by the user EOA only.

## Upgrade

Settlement itself is upgradable via DatumGovernanceRouter, but the
storage layout is fixed by the snapshot. Most upgrades happen at the
Logic-contract level — swap LogicA or LogicB while Settlement and
its storage stay put. `setLogic(A, B)` updates both pointers
atomically; the layout snapshot test prevents drift; `lockLogic()`
post-OpenGov freezes the pair.

A full Settlement upgrade is the path of last resort. The
`_migrate` override would need to copy ~50 storage slots; the bulk
of the state lives in mappings that can't be enumerated on-chain.
Production Settlement migration would coordinate the dust mappings
off-chain or accept a fresh start.
