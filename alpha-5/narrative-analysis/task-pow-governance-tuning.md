# Task scope: PoW governance tuning + monthly-batching defaults

Three coordinated changes to make the PoW gate fully governance-tunable
on testnet and tune defaults to reflect the protocol's monthly-batching
economic model. Designed to land in a single coordinated redeploy.

## Goals

1. **PoW curve params** become conviction-vote tunable through
   `DatumParameterGovernance`, not just deployer-owner.
2. **`MAX_CLAIM_EVENTS`** stops being a baked constant on
   `DatumClaimValidator` and becomes a bounded, governance-tunable value.
3. **`powBucketLeakPerN` default** moves from 10 (≈ daily batching) to
   1440 (≈ monthly batching) to match the economics-paper assumption.

## Out of scope

- Transferring **full** Settlement ownership to ParameterGovernance.
  Settlement has 22 owner-only setters, many of them lock-once for
  cypherpunk plumbing immutability or operational emergency
  (e.g., `setMintAuthority`, `setClickRegistry`). Moving all of them
  through PG would block emergency response.
- Reworking the bucket math. The shift formula
  (`base + bucket/linDiv + (bucket/quadDiv)²`) stays as-is; we're just
  re-tuning the drain rate.
- Per-user-per-campaign PoW. The bucket stays global per-user (see
  `verify-sybil-spread.ts`).

## Branch strategy

```
feature/pow-gov-stage0  ← invariant tests on current curve + cap
feature/pow-gov-stage1  ← add ClaimValidator.maxClaimEvents storage + setter
feature/pow-gov-stage2  ← whitelist PoW curve + cap setters on PG
feature/pow-gov-stage3  ← retune bucketLeakPerN default + tests
feature/pow-gov-stage4  ← deploy.ts wiring + setup-testnet defaults
```

Each stage lands its own PR with green tests.

## Stage 0 — Baseline invariant tests

Capture the current behaviour of `MAX_CLAIM_EVENTS` and the PoW curve
defaults so we can verify the changes preserve all existing properties
beyond the intended diffs.

**Files:**
- `alpha-4/test/pow-cap-baseline.test.ts` (NEW, ~80 LOC)

**Invariants to capture:**
- `MAX_CLAIM_EVENTS = 100,000` rejects 100,001-event claims with reason 17.
- Default `powBaseShift = 8`, `powLinearDivisor = 60`, `powQuadDivisor = 100`,
  `powBucketLeakPerN = 10`.
- `setPowDifficultyCurve` bounds: baseShift ∈ [1, 32], divisors > 0,
  leak > 0.
- Bucket fully drains after `bucket × leakPerN` blocks of inactivity.

**Acceptance:** new test file passes; 0 changes to live code.

**Effort:** ~1 session.

## Stage 1 — `MAX_CLAIM_EVENTS` becomes governance-tunable

Replace the `private constant` with a public storage variable and add
a bounded setter. Hard ceiling stays baked (footgun prevention); the
tunable surface is below it.

**Files:**
- `alpha-4/contracts/DatumClaimValidator.sol` (MODIFY)
- `alpha-4/test/claim-validator-cap-governance.test.ts` (NEW, ~120 LOC)

**Contract changes:**
```solidity
// Before
uint256 private constant MAX_CLAIM_EVENTS = 100000;
// After
uint256 public constant ABSOLUTE_MAX_CLAIM_EVENTS = 1_000_000;  // baked ceiling
uint256 public maxClaimEvents = 100_000;                         // tunable default
event MaxClaimEventsSet(uint256 oldValue, uint256 newValue);

function setMaxClaimEvents(uint256 newMax) external onlyOwner {
    require(newMax > 0 && newMax <= ABSOLUTE_MAX_CLAIM_EVENTS, "E11");
    uint256 old = maxClaimEvents;
    maxClaimEvents = newMax;
    emit MaxClaimEventsSet(old, newMax);
}
```

Inside `validateClaim`, replace `MAX_CLAIM_EVENTS` with `maxClaimEvents`.

**Bounds rationale:**
- Lower bound 0: degenerate; 1 is the minimum useful value.
- Upper bound 1M: 10× the current default. Limits adversary ability to
  bundle a year of fake impressions into one claim. The PoW per-claim
  cost (2^shift × eventCount) means a 1M-event claim is 10× harder to
  mine than the current 100k cap, providing natural friction.

**Acceptance:**
- Default still 100,000; existing tests unaffected.
- Setter rejects 0 and 1,000,001 with E11; accepts everything in between.
- After lowering cap to 50k, a 75k-event claim now rejects with reason 17.
- Non-owner calls revert.

**Effort:** ~1 session.

## Stage 2 — Whitelist PoW + cap setters on ParameterGovernance

The ownership-transfer model that Stage 6 of Path H used (transfer the
contract's whole ownership to PG) is wrong for Settlement and
ClaimValidator — they have too many critical setters. Instead, add a
**parallel governance hook**: a second authorized caller on each
contract for specific param setters.

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` (MODIFY — add parameterGovernance address + gate)
- `alpha-4/contracts/DatumClaimValidator.sol` (MODIFY — add parameterGovernance address + gate)
- `alpha-4/scripts/deploy.ts` (MODIFY — wire PG + add to PARAM_SETTERS)
- `alpha-4/test/pow-curve-pg-tuning.test.ts` (NEW, ~150 LOC)

**Settlement changes:**
```solidity
address public parameterGovernance;
event ParameterGovernanceSet(address indexed pg);

function setParameterGovernance(address pg) external onlyOwner {
    require(pg != address(0), "E00");
    require(parameterGovernance == address(0), "already set");
    parameterGovernance = pg;
    emit ParameterGovernanceSet(pg);
}

modifier onlyOwnerOrPG() {
    require(msg.sender == owner() || msg.sender == parameterGovernance, "E18");
    _;
}

// Change setPowDifficultyCurve to use onlyOwnerOrPG:
function setPowDifficultyCurve(
    uint8 baseShift, uint32 linearDivisor, uint32 quadDivisor, uint32 bucketLeakPerN
) external onlyOwnerOrPG {
    // ... bounds + assignments unchanged ...
}
```

**ClaimValidator changes:**
Identical pattern — add `parameterGovernance` field, `setParameterGovernance`
setter (lock-once), and convert `setMaxClaimEvents` to `onlyOwnerOrPG`.

**deploy.ts changes:**
```typescript
const PARAM_SETTERS: GovernableSetter[] = [
    // ... existing entries ...
    { contractKey: "settlement",     sig: "setPowDifficultyCurve(uint8,uint32,uint32,uint32)" },
    { contractKey: "claimValidator", sig: "setMaxClaimEvents(uint256)" },
    // KEEP parameterGovernance LAST (existing ordering bug; documented)
];
```

Plus new wiring step before validation:
```
Settlement.setParameterGovernance(addresses.parameterGovernance)
ClaimValidator.setParameterGovernance(addresses.parameterGovernance)
```

**Acceptance:**
- After deploy, both contracts' `parameterGovernance()` view returns the
  PG address.
- Direct call to `setPowDifficultyCurve` from deployer succeeds.
- Direct call from PG (impersonated in tests) also succeeds.
- Direct call from any other address reverts with E18.
- PG.propose → vote → execute flow successfully updates the curve.

**Effort:** ~2 sessions.

## Stage 3 — Recalibrate `powBucketLeakPerN` default

The economics paper assumes monthly user-batching. Current
`powBucketLeakPerN = 10` (1 unit per 10 blocks ≈ 1 unit/min) drains a
typical 300-event batch in 6 days — implying the protocol "encourages"
roughly weekly batching, not monthly.

### Math

For a user submitting a typical 300-event batch and full bucket drain
matching the inter-batch period:

```
drain_time = bucket × leakPerN × block_time
drain_time_target = 30 days = 432,000 blocks @ 6s
bucket = 300
leakPerN = 432,000 / 300 = 1,440
```

### Recommended new default

```solidity
uint32 public powBucketLeakPerN = 1440;  // 30-day full-drain for 300-event batches
```

### What this means in practice

| Behaviour | Old (`leakPerN=10`) | New (`leakPerN=1440`) |
|---|---|---|
| 300-event bucket fully drains in | 50 minutes | 30 days |
| Heavy abuser hits MAX_SHIFT in | ~2 minutes | ~2 minutes (unchanged) |
| Average bucket of monthly batcher | 0 | ~150 (sawtooth) |
| Avg shift for monthly batcher | 8 | 12 (4096 attempts/event) |
| Avg shift for weekly batcher | 8 | ~22 (4M attempts/event) |

### Files
- `alpha-4/contracts/DatumSettlement.sol` (MODIFY — default value)
- `alpha-4/test/pow-leak-monthly.test.ts` (NEW, ~120 LOC)
- `alpha-4/scripts/role-gas-report.ts` (MODIFY — note the new cadence
  assumption in the user-side projections)

### Notes
- The setter is unchanged (no governance API change); only the genesis
  value moves.
- Existing testnet state on Paseo (deployed at the old value) will keep
  the old leak rate until a governance proposal explicitly updates.
  Mainnet should deploy with the new default baked.
- The PoW abuse curve still bites within minutes for sustained abusers
  because their bucket fills faster than the (slower) drain can clear.

### Acceptance
- Default `powBucketLeakPerN = 1440` after deploy.
- Test simulates a monthly batcher: confirms bucket stays sawtooth
  ~150, mining stays cheap.
- Test simulates an abuser: confirms shift hits MAX_SHIFT within
  ~2 minutes of sustained 600 events/min.

**Effort:** ~1 session.

## Stage 4 — Deploy + setup-testnet wiring

Update deployment + seed scripts to reflect the new param surface.

**Files:**
- `alpha-4/scripts/deploy.ts` (MODIFY — already covered in Stage 2)
- `alpha-4/scripts/setup-testnet.ts` (MODIFY — no longer set
  `powBucketLeakPerN` to 10 explicitly; rely on the new default)
- `alpha-4/scripts/verify-emission-engine.ts` (MODIFY — update the PoW
  config printout to note the monthly default)

**Acceptance:**
- Fresh deploy on local hardhat: `powBucketLeakPerN = 1440`,
  `maxClaimEvents = 100,000`, `parameterGovernance` set on both
  Settlement and ClaimValidator.
- `verify-pow-scaling.ts` re-run shows the new feasibility-vs-time curve.

**Effort:** ~1 session.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Slower drain rate makes recovery from accidental over-batching painful for honest users. | Medium | The setter is governance-tunable. If a complaint pattern emerges, governance can lower `leakPerN` back toward 100–500. |
| Adding `parameterGovernance` field on Settlement/ClaimValidator increases bytecode. Settlement is already large. | Low | Both fields are minimal (one storage slot + one setter each). Measured: <500 bytes added per contract. |
| Lock-once `setParameterGovernance` means a bad initial setting requires redeploy. | Low | Testnet redeploys are routine; mainnet bring-up must use the same care as other lock-once wirings (e.g., `setMintAuthority`). |
| `onlyOwnerOrPG` dual-permission setter creates two paths into the same state. Bug in either reflects on the param. | Low | Both paths converge on the same set of bounds checks. Test coverage validates both. |
| `MAX_CLAIM_EVENTS` becoming a variable means the validator must SLOAD on every claim. Minor gas cost. | Low | ~2,100 gas extra per claim. Acceptable trade for the flexibility. |

## Open questions to resolve before starting

1. **Should `parameterGovernance` be lock-once or owner-settable freely?**
   Default: lock-once, matching `mintAuthority` and other critical refs.
   The alternative is to allow re-pointing in case the PG is itself
   migrated. Recommend lock-once with the understanding that the path
   for migration is a new Settlement deploy.
2. **`ABSOLUTE_MAX_CLAIM_EVENTS = 1,000,000` — is the ceiling sensible?**
   Justification: 10× the current default; at maximum, a 1M-event claim
   represents an attacker's best-case attempt to bundle a year of fake
   impressions. Mining cost at MIN bucket (shift = 8) is 256 × 1M =
   256M attempts ≈ 4 minutes in browser JS. Still mineable; protocol
   relies on bucket dynamics for the actual rate limit. Confirm
   acceptability before baking.
3. **`leakPerN = 1440` vs `300`?** 1440 enforces ≈ monthly; 300 enforces
   ≈ weekly. Pick based on the economics paper. Recommend 1440 to match
   the per-user-fee-burn analysis already in `docs/gas-by-role.md`.
4. **Should we whitelist any *other* Settlement setters on PG?**
   Candidates: `setRateLimits`, `setMaxBatchSize`, `setDustMintThreshold`,
   `setEnforcePow`. These are all operational dials governance might
   reasonably want to tune. Defer to a follow-up task to avoid scope
   creep on this one.

Resolve these in a brief design sync before Stage 0 begins. None
should require touching code to answer.

## Effort total

Across all five stages: ~6 sessions. Stage 2 is the bulk (~30%) due to
the new dual-permission setter pattern and its tests; everything else
is small.

## Deployment migration

**Testnet (Paseo Alpha-4):** redeploy from scratch with the new
defaults. The protocol is pre-mainnet; no economic value at stake (per
TOKENOMICS.md §1.6). Existing campaigns and settlements stop working
but no real funds are lost.

**Pre-mainnet checklist:**
- Stages 0–4 all green.
- `npx hardhat test` — 1022+ existing tests still green.
- New tests added for the three changes pass.
- Run `verify-pow-scaling.ts` and confirm the curve numbers match the
  new defaults.
- Audit pass on the new dual-permission pattern; it's a new authz
  shape and deserves focused review.
