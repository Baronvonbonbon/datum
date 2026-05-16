# PoW timing and amortization

How and when the per-user PoW gate fires — three distinct events happening at
three distinct times — and what that means for user UX, batching strategy, and
abuse resistance.

## Three things, three times

The system deliberately separates **off-chain accumulation** from **on-chain
verification**. Each layer is decoupled from the others.

### 1. Impressions (events) — recorded off-chain in real time

When the user views an ad in the extension, the impression is logged locally —
**not on-chain**. There is no on-chain cost per impression. The extension keeps
a running counter of unclaimed impressions per `(publisher, campaign,
actionType)` tuple.

The on-chain contract never sees individual impressions; it only sees the
aggregate `eventCount` field of a claim.

### 2. `claimHash` — built when the user commits to a batch

The claim's hash is:

```
claimHash = keccak256(abi.encode(
    campaignId, publisher, user,
    eventCount, ratePlanck, actionType,
    clickSessionHash, nonce, previousClaimHash, stakeRootUsed
))
```

All ten fields must be known to compute the hash. The most operationally
binding field is `eventCount`. The user can build the hash any time they
commit to a final count.

### 3. PoW — mined off-chain, verified on-chain at submit

The check lives in `DatumClaimValidator.validateClaim` (line 361):

```solidity
if (uint256(keccak256(abi.encodePacked(computedHash, claim.powNonce))) > target) {
    return (false, 27, 0, bytes32(0));
}
```

- `computedHash` — the claim's hash (already committed)
- `claim.powNonce` — the nonce the user chose
- `target` — computed **at submission time** from the user's **current bucket**
  via `powTargetForUser(user, eventCount)`

The mining itself — finding a `powNonce` such that
`keccak256(claimHash || powNonce) ≤ target` — is purely client-side work. The
user can do it whenever they want, on any device, before submitting.

## Can the PoW be amortized over a month?

**Yes — with one caveat.** Two amortization strategies work:

### Strategy A — commit-then-mine

1. User commits up front: "I'll batch ~N impressions this month."
2. Extension fixes `eventCount = N`, builds the `claimHash` template, and
   starts mining the `powNonce` in the background while ad views accumulate.
3. By submission time the nonce is ready; submit is instant.

For a typical N = 50,000 events with empty bucket (shift = 8): average attempts
≈ `2^8 × 50,000 = 12.8M`. At a conservative 1M hashes/sec in browser JS that's
~13 seconds of CPU spread across the month — effectively free.

### Strategy B — mine at submit

1. User accumulates views, decides at the end of the period.
2. Builds the claim with the actual final count, mines just before submitting.

For typical batch sizes the mining is seconds anyway. This is the simplest UX
default.

### The caveat — submission-time bucket binding

`target` depends on the user's **bucket at submission time**, not at mining
time. If the user has been settling other claims during the month, their
bucket grows and the target shrinks — pre-mined nonces against an
"empty-bucket" target may no longer satisfy.

**So Strategy A only works if the user stays quiet on-chain during the month**,
which is exactly the intended pattern. Sparse settlers get cheap PoW;
high-frequency settlers face exponentially rising difficulty per claim.

## What the design rewards

Two user archetypes, two different PoW experiences:

| User type | On-chain frequency | Bucket level | PoW per claim |
|---|---|---|---|
| Sparse human (1 batch/month) | low | ≈ 0 | trivial (~256 attempts × eventCount) |
| Active human (1 batch/day) | medium | low (drains hourly) | still trivial |
| Heavy claimer (6 batches/hour) | high | grows ~5/min | gets expensive within an hour |
| Sybil farm (10 claims/sec) | very high | saturates fast | **infeasible within 2 minutes** |

The throttle is not "you must do PoW per impression" — it is **"your
*settlement frequency* costs more PoW the faster you go."** The longer a
user pauses between settles, the more the bucket drains, and the cheaper the
next mining becomes.

## Operational consequences

### MAX_CLAIM_EVENTS = 100,000

`DatumClaimValidator.sol` line 56 caps any single claim's `eventCount` at
100,000. Users with more impressions in a period must split into multiple
claims. Crucially: the second claim's PoW target is computed against the
bucket *after* the first settle landed, so multi-claim batches face
progressively harder mining on each step.

This is intentional — it prevents an attacker from cramming a year's worth
of fake impressions into one batch and mining once.

### Streaming pre-mining vs. lump-sum submission

The amortization strategy turns PoW from a "one-time spike" into a
"background CPU rounding error" for honest users:

```
Strategy B (mine at submit):
  T=0 ............................ T=submit
  [ no PoW work ]                  [13 sec burst, then submit ]

Strategy A (background mining):
  T=0 ............................ T=submit
  [ ~0.01% CPU continuously       ] [ instant submit ]
```

Both arrive at the same chain-side state. Extensions should default to
Strategy A so submit feels instantaneous.

### Can a publisher or relay help with PoW?

**No.** The user signs `claimHash`, which commits to the user's chosen
`powNonce`. If a publisher or relay tried to swap in a different nonce,
the resulting `claimHash` would differ and the user's signature would no
longer verify.

The user is the only party who can produce a valid `(claimHash, powNonce)`
pair, regardless of which submission path (raw `settleClaims`, relay-signed
`settleClaimsFor`, or dual-sig `settleSignedClaims`) eventually puts the
claim on chain.

### What happens if the user mines for an old target and the bucket grew?

The pre-mined nonce no longer satisfies the new (lower) target. Settlement
will reject the claim with reason code 27 (PoW failed). The user must
re-mine against the current target.

This is a self-healing design: there is no way for an attacker to bank
"easy" PoW nonces and submit them later when their bucket is high — every
submission is checked against the current bucket. The bucket can only
*drain* to lower difficulty (via elapsed blocks); a stale nonce mined when
the bucket was at level X will still work as long as the current bucket is
≤ X.

## Bottom line

- **Events** are counted off-chain in the extension, real-time, free.
- **`claimHash`** is built whenever the user commits to a batch size.
- **`powNonce` mining** happens off-chain, at any time, before submission.
- **Verification** happens on-chain, at submit, against the **current**
  user bucket.

A sparse-settlement user can amortize mining over the entire claim-building
period. A high-frequency user cannot — each settle pushes the bucket up,
and subsequent claims face freshly-raised difficulty.

The throttle is on **per-user on-chain settlement throughput**, not on
ad-view rate or claim composition. Real users batching once a day or once
a month see PoW as a non-event; bots trying to spam settle transactions
get crushed by exponential cost.
