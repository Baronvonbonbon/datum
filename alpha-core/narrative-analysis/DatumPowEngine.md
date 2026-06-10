# DatumPowEngine

Per-impression proof-of-work difficulty calculator. Carved out of
DatumSettlement (alpha-4 EIP-170) so it can be upgraded independently
via DatumGovernanceRouter and so Settlement stays under the runtime
cap. The actual PoW verification — checking that
`hash(claim) < powTargetForUser(user, eventCount)` — happens in
`DatumClaimValidator`; this contract owns the *target* function and
the per-user state it depends on.

Companion docs:
- `pow-timing-and-amortization.md` — design rationale for the
  leaky-bucket model + per-batch amortization
- `task-pow-governance-tuning.md` — governance interface for tuning
  the curve

## The leaky-bucket model

Each user has a difficulty bucket. Every settled batch adds
`eventCount` units to the bucket; the bucket drains 1 unit per
`powBucketLeakPerN` blocks. Bucket level drives a non-linear shift:

```
bucket = max(0, userPowBucket - (blocksElapsed / powBucketLeakPerN))
shift  = powBaseShift                        // absolute floor (default 8)
       + bucket / powLinearDivisor           // gentle linear growth (default /60)
       + (bucket / powQuadDivisor)^2         // quadratic on sustained abuse (default /100)
shift  = min(shift, POW_MAX_SHIFT)           // 64 = effectively impossible
target = (type(uint256).max >> shift) / eventCount
```

Sustained abuse keeps the bucket full and quadratic difficulty kicks
in — the user's effective PoW target shrinks toward zero, making
new submissions impractical. Slowing or stopping settles drains the
bucket and difficulty decays back to baseline.

The `bucket / powQuadDivisor` is clamped to `uint32.max` before
squaring so the math never overflows the `uint256` shift accumulator.
A shift of 64 or more returns target 0 (no valid hash exists, so
all submissions reject in the validator).

## Why per-batch consume, not per-claim

Settlement's `_processBatch` aggregates `eventCount` across all
settled claims and calls `consumeFor(user, totalEvents)` exactly
once after the per-claim loop. This is semantically identical to
per-claim consumes within the same batch (`block.number` is the
same, so the drain term resolves to zero between successive claims;
only the accumulator advances). The batched form saves gas.

## Hot path

`consumeFor(user, eventCount)`:

1. Gated to `msg.sender == settlement` (E00 `OnlySettlement`).
2. No-op on `eventCount == 0`.
3. Drains the bucket by `(block.number - lastUpdate) / powBucketLeakPerN`,
   clamping at zero.
4. Adds `eventCount` to the (possibly drained) bucket.
5. Records `block.number` as the new `lastUpdate`.

`powTargetForUser(user, eventCount)` is the view consumed by
ClaimValidator at PoW-verification time. Returns `type(uint256).max`
when PoW is disabled (`enforcePow == false`) or when `eventCount == 0`.

## Governance surface

- **`setEnforcePow(bool)`** — owner-only, `whenNotFrozen`. Master
  on/off switch.
- **`setPowDifficultyCurve(baseShift, linearDivisor, quadDivisor,
  bucketLeakPerN)`** — owner OR `parameterGovernance` (PG.execute path).
  Bounded: baseShift ∈ [1, 32]; divisors > 0; leak > 0.
- **`setParameterGovernance(addr)`** — owner-only, lock-once (revert
  `AlreadySet` on second call). Intended for
  `DatumParameterGovernance`.
- **`setSettlement(addr)`** — owner-only; locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase` (reverts
  pre-OpenGov). Permanent.

## Upgrade

`lockPlumbing` is the cypherpunk plumbing-lock — once flipped the
Settlement reference is frozen. The PowEngine contract itself remains
upgradable via DatumGovernanceRouter; the `_migrate` override would
need to copy `userPowBucket` + `userPowBucketLastUpdate` to preserve
user history.

The two-divisor (`linearDivisor`, `quadDivisor`) shape was chosen so
the curve has a gentle ramp into the quadratic region. Switching to
a different curve shape — say, exponential — is a per-contract
upgrade, not a parameter change.

## Trust assumptions

- Settlement is the sole authorized writer. There is NO external
  reporter-EOA path (threat model #4: a compromised reporter could
  poison every user's bucket and DoS settlements protocol-wide).
- The bucket's drain rate is a parameter; an adversarial governance
  setting `bucketLeakPerN = 1` would effectively disable PoW
  (bucket always drains faster than it fills). The constraint
  `bucketLeakPerN > 0` is the only check — calibration is operational
  discipline.
- `powBaseShift = 8` is the floor; even with an empty bucket, every
  claim must produce a hash below `type(uint256).max >> 8`, i.e. its
  high byte must be zero. Cheap but non-trivial.
