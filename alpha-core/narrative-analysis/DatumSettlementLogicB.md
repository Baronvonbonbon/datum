# DatumSettlementLogicB

The heart of the Settlement two-Logic split. Owns `processBatch` —
the inner pipeline that takes one `(user, campaignId, claims[])`
batch and runs it end-to-end: identity gates, per-claim validation
+ rate-limit + nullifier consume, chain-state writes, payment
math, budget deduction, paymentVault credit, optional token-reward
credit, mint coordination, publisher reputation recording, and
auto-completion if the budget exhausts.

If LogicA is the dispatch and auth layer, LogicB is the business
logic. Everything that touches money or chain state flows through
this contract.

## How it's invoked

Exclusively via DELEGATECALL. Three paths reach it:

1. **Relay path** — `Settlement.settleClaims` / `settleClaimsMulti`
   → DELEGATECALL into LogicA → DELEGATECALL into LogicB (chained).
2. **Dual-sig path** — `DatumDualSigSettlement.settleSignedClaims`
   verifies EIP-712 sigs → calls Settlement's external
   `processVerifiedBatch` (gated to `msg.sender == _dualSig`) →
   DELEGATECALL into LogicB directly (no LogicA hop).
3. **Direct test harness** — `MockMsgSenderProbe` style tests in
   `test/settlement-msgsender.test.ts` confirm `msg.sender` is the
   original outer caller, not Settlement or LogicA.

Like LogicA, calling LogicB at its own address is inert: its own
storage has `_budgetLedger == address(0)`, so the first external
dependency reverts.

LogicB does NOT carry `nonReentrant`. Settlement (or LogicA acting
under Settlement's storage) holds the guard on the `_status` slot
that LogicB inherits via `DatumSettlementStorage`. Adding another
`nonReentrant` here would double-lock the shared slot.

## The pipeline

`processBatch(user, campaignId, claims[], advertiserConsented)`
returns `(settled, rejected, paid)`. Each step short-circuits on
failure with a `ClaimRejected` event carrying a reason code (the
codes are the protocol's observable adversary signal; see
`docs/error-codes.md` or the code's inline comments).

1. **Batch caps.** `claims.length <= _maxBatchSize` or revert.
2. **CB2 self-pause** (reason 27). `_userPaused[user]` rejects every
   claim, returns immediately.
3. **CB1 advertiser blocklist** (reason 28). Uses
   `Campaigns.getCampaignAdvertiserSafe` (audit-hedge #4 — fail-closed
   on the gradient). Rejects all if the user has blocked the
   campaign's advertiser.
4. **M1-fix L3 floor** (reason 26). If `_userMinAssurance[user] >= 3`,
   the campaign must require a ZK proof. The user opted in to ZK; an
   advertiser cosig doesn't satisfy this.
5. **People Chain identity gate** (reason 30). Effective min ID =
   `max(campaign.minIdentityLevel, user.userMinIdentityLevel)`. When
   non-zero, the user must have a non-expired attestation at that
   level. Fail-CLOSED on identity-registry revert.
6. **AssuranceLevel gate** (reasons 24 / 25). Pure helper
   `_assuranceDecision(campaignLevel, userFloor, advertiserConsented,
   fromRelay, fromPublisherRelay)` returns `(accept, reasonCode)`.
   Lifted to the storage base for audit-hedge #5 table-testing.
7. **BM-10 min claim interval** (reason 18). Rejects entire batch if
   `block.number < lastSettlementBlock + interval`.
8. **Reputation pre-check** (reason 20). `_reputation.canSettle(publisher)`
   gates the batch; rejects all if the publisher is in
   anomaly-detected probation.

Per-claim loop (each step on individual claims):

9. **Same-campaign assertion** (reason 0). `claim.campaignId == batch
    campaignId`.
10. **Gap propagation** (reason 1). Once `gapFound` is set, every
    subsequent claim in the batch is rejected — the chain has to stay
    linear.
11. **Settlement blocklist** (reason 11). M2-fix gradient + H-3 fix:
    at `effectiveLevel >= 1`, uses `publishers.isBlockedStrict` (fail
    closes on revert); at L0, uses `isBlocked` (fail-open, prefers
    liveness).
12. **User per-claim publisher block** (reason 28). `_userBlocksPublisher[user][publisher]`
    propagates `gapFound`.
13. **ClaimValidator.validateClaim** — hash chain, nonce monotonicity,
    PoW, ZK proof. Returns `(ok, reasonCode, cTakeRate, computedHash)`.
    Reason 7 sets `gapFound`.
14. **BM-2 per-user cap** (reason 13). `_userCampaignSettled + eventCount
    <= MAX_USER_EVENTS` (100,000).
15. **Per-campaign window cap** (reason 29). `Campaigns.getCampaignUserCapSafe`
    returns `(capMax, capWin)`; rejects if window total exceeds the cap.
16. **BM-5 rate limiter** (reason 14). `RateLimiter.tryConsume` is
    atomic — failure is a non-side-effecting check. View claims only
    (actionType 0).
17. **FP-1 publisher stake gate** (reason 15). `PublisherStake.isAdequatelyStaked`.
18. **FP-5 nullifier consume** (reason 19). `NullifierRegistry.tryConsume`
    is atomic. View claims with `nullifier != bytes32(0)` only.

Effects (CEI: chain state before external calls):

19. `_lastClaimHash` / `_lastNonce` updated.
20. **CPC click** — `ClickRegistry.markClaimed` for actionType 1.
21. **Payment math** — view: `rate * events / 1000`; click/action:
    `rate * events`. Then `publisher = total * cTakeRate / 10000`,
    `userPayment = (total - publisher) * userShareBps / 10000`,
    `protocolFee = remainder - userPayment`.
22. **BudgetLedger.deductAndTransfer** — if returns `exhausted=true`,
    sets `gapFound` and schedules auto-complete.
23. Aggregator (`BatchAggregate`) accumulates totals + token reward
    contribution (`eventCount * rewardPerImpression`).

Post-claim-loop:

24. **PoW leaky bucket** — `_powEngine.consumeFor(user, eventsSettled)`.
25. **L-7 global circuit breaker** (E80). `_cbTotal += agg.total`; reverts
    if `_cbTotal > _maxSettlementPerBlock`.
26. **PaymentVault.creditSettlement** — pull-pattern credits for
    publisher / user / protocol.
27. **MintCoordinator.coordinate** — DATUM emission per claim.
28. **TokenRewardVault.creditReward** — try/catch, emits
    `RewardCreditFailed` on revert (L-4: non-critical reward path must
    not DoS DOT settlement).
29. **PublisherStake.recordImpressions** — advance bonding curve.
30. **AdvertiserStake.recordBudgetSpent** — best-effort via low-level
    call (CB4: secondary economic signal).
31. **Reputation.recordSettlement** — settled + rejected deltas.
32. **Lifecycle.completeCampaign** — if budget exhausted.
33. **BM-10 last-block update** — only if any claim was successfully
    settled in this batch.

## SAFETY annotations (audit-hedge #9)

Every try/catch in the pipeline carries a `// SAFETY:` comment naming
the gradient rule (M2-fix, H2-fix, etc.) and the consequence of the
opposite choice. The convention is auditable in a single grep:

- Fail-CLOSED at L1+ (M2-fix, H-3 fix): blocklist, identity registry.
- Fail-OPEN at L0 (M2-fix): blocklist liveness preference.
- Fail-SOFT (L-4): token reward credit, advertiser stake recording —
  the primary value flow has already completed.
- Fail-CLOSED with safe-getter (hedge #4): Campaigns reads use
  `*Safe` variants that return `(ok, value)` instead of reverting.

## Invariants

- Chain state writes (`_lastNonce`, `_lastClaimHash`) happen BEFORE
  any external call (CEI).
- `gapFound` propagates within a batch — once any claim is rejected
  with a chain-breaking reason, every subsequent claim is rejected.
- `_userCampaignSettled` is only incremented when a claim survives all
  prior checks; the increment happens BEFORE the per-window cap check
  to keep ordering consistent.
- The circuit breaker (`E80`) reverts the entire batch — any partial
  settlements within this batch are rolled back by the outer
  `nonReentrant` revert.

## Upgrade

LogicB is the other half of the lock-once Logic pair (paired with
LogicA via Settlement's `setLogic(A, B)`). Same lock-once semantics:
audit-hedge #3 `_logicLocked` freezes both pointers post-OpenGov.

Layout invariant: never declare additional state in this contract.
New fields go on `DatumSettlementStorage`.
