# DatumSettlement

The protocol's bottleneck — every claim becomes a payment here, or it doesn't.
Settlement reads claims, runs them through `DatumClaimValidator`, decides who
gets paid what, deducts from `DatumBudgetLedger`, and credits earnings to
`DatumPaymentVault`. Optionally mints DATUM via `DatumMintAuthority`, credits
ERC-20 rewards via `DatumTokenRewardVault`, updates publisher reputation, and
advances the publisher/advertiser stake bonding curves.

It is also where most of the protocol's adversarial defenses live in one
place: the AssuranceLevel gate, the per-user/per-publisher rate limits, the
leaky-bucket PoW, the nullifier registry, the user self-pause / blocklist,
and the global per-block circuit breaker.

## Three settlement paths

1. **`settleClaims(ClaimBatch[])`** — direct path. Allowed callers: the user
   themselves, the relay contract, the attestation verifier, or the
   publisher's relay signer. Suitable for L0 campaigns where no publisher
   cosig is enforced at the protocol level (publisher cosig may still be
   enforced upstream via DatumRelay).
2. **`settleClaimsMulti(UserClaimBatch[])`** — batch variant of the above
   that lets a relay submit claims for multiple users × campaigns in one tx.
3. **`settleSignedClaims(SignedClaimBatch[])`** — dual-sig path. Each batch
   carries both a publisher and an advertiser EIP-712 signature over
   `(user, campaignId, claimsHash, deadlineBlock, expectedRelaySigner,
   expectedAdvertiserRelaySigner)` on the DatumSettlement EIP-712 domain.
   This is the only path that satisfies AssuranceLevel ≥ 2. Both parties
   can refute by withholding their sig; relay-key rotations on either side
   invalidate in-flight cosigs (A1 + M6 anti-staleness).

## The `_processBatch` core

All three paths funnel into `_processBatch(user, campaignId, claims, result, advertiserConsented)`. Order of checks:

1. **User self-pause** (CB2): if the user has set `userPaused[user] = true`, the batch is rejected wholesale.
2. **User advertiser blocklist** (CB1): if the user has blocked the advertiser, rejected wholesale.
3. **User-floor AssuranceLevel ≥ 3** (M1): user demands ZK-required; campaign must `getCampaignRequiresZkProof == true` or batch rejects.
4. **AssuranceLevel gate** (A3): combines campaign-set level and user-set floor (`userMinAssurance`). Level 2 requires the dual-sig path; level 1 requires either relay or publisher-relay msg.sender.
5. **Per-user min claim interval** (BM-10).
6. **Reputation gate** (safe rollout): caller publisher's score must be ≥ `minReputationScore`.
7. **Then per-claim loop:**
   - campaignId match
   - **Publisher blocklist** (S12). At L1+, calls `isBlockedStrict` so a curator revert fails CLOSED (audit H-3). At L0, falls open via `isBlocked`.
   - User per-claim publisher block (CB1).
   - **`claimValidator.validateClaim`** — the full Check 0–11 suite.
   - **MAX_USER_EVENTS** per (user, campaign, actionType).
   - **Per-user-per-window event cap** read from Campaigns (`#1` extension).
   - **Per-publisher window rate limit** (BM-5).
   - **Publisher stake adequacy** (FP-1).
   - **Nullifier replay check** (FP-5, view claims only).
   - Effects: update `lastNonce`, `lastClaimHash`, register nullifier, mark click session claimed.
   - Compute payment splits (see below), deduct from `BudgetLedger`, accumulate per-batch.
   - Update the leaky-bucket PoW bucket.
   - Update `userTotalSettled` (sybil-history feed).

## The payment formula

Revenue is split per claim then aggregated per batch:

```
totalPayment   = (ratePlanck × eventCount) / 1000   (view, type-0)
               = ratePlanck × eventCount             (click, action)

publisherPayment = totalPayment × snapshotTakeRateBps / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder × userShareBps / 10000   (default 7500 = 75%)
protocolFee      = remainder - userPayment
```

`userShareBps` is bounded to `[5000, 9000]` by `setUserShareBps`. The take rate
is snapshotted into the campaign at creation, so a publisher who later raises
their take doesn't apply it retroactively.

## DATUM mint (optional)

If `mintAuthority != address(0)`, after the DOT settlement Settlement
computes `totalMint = agg.total × mintRatePerDot / 1e10` and (if above
`dustMintThreshold`) calls `mintForSettlement(user, publisher, advertiser,
amounts...)`. The split (55/40/5 default) is governance-tunable; the mint
authority enforces its own 95M global cap. The whole flow is in a try/catch
— a mint cap hit emits `DatumMintFailed` but never reverts settlement.

## Lock-once references

Every structural reference (budgetLedger, paymentVault, lifecycle, relay,
claimValidator, attestationVerifier, publishers, tokenRewardVault, campaigns,
publisherStake, advertiserStake, clickRegistry, mintAuthority, nullifierWindowBlocks)
is settable exactly once. Audit B8/D3 fixes: structural refs are the largest
rug surface, so a fresh Settlement deploy is the only way to re-point them.

## Cap and rate-limit knobs (governance-tunable)

- `rlWindowBlocks` + `rlMaxEventsPerWindow` — per-publisher rate limit. Window size is itself lock-once (audit A8) so a mid-flight resize can't invalidate or re-open a window.
- `minClaimInterval` — minimum blocks between batches per (user, campaign, actionType).
- `maxSettlementPerBlock` — global circuit breaker. 0 = disabled.
- `minReputationScore` — bps floor for publisher acceptance rate.
- `enforcePow` + `powBaseShift / powLinearDivisor / powQuadDivisor / powBucketLeakPerN` — leaky-bucket PoW curve.
- `userShareBps`, `datumRewardUserBps/PublisherBps/AdvertiserBps`, `mintRatePerDot`, `dustMintThreshold` — economic knobs.
- `userMinAssurance` (user-set), `userBlocksPublisher` (user-set), `userBlocksAdvertiser` (user-set), `userPaused` (user-set) — per-user sovereignty knobs.

## Why this contract is huge

1418 LOC because it absorbed `DatumSettlementRateLimiter`, `DatumNullifierRegistry`,
and `DatumPublisherReputation` in the alpha-4 merge. Three sub-features that
were previously cross-contract reads (each costing ~2.1KB PVM bytecode + a
staticcall) became local mappings. The cost is contract size; the benefit is
~30% gas reduction on the hot path.
