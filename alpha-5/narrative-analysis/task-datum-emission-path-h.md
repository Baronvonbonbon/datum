# Task Scope: DATUM emission — Path H implementation

Concrete breakdown of the work to grow `DatumSettlement` from the
current flat-rate `mintRatePerDot` placeholder into the full Path H
mechanism specified in `TOKENOMICS.md` §3.3: baked 7-year halvings,
daily emission cap, dynamic per-DOT rate adjustment, and per-claim
mint clipping.

## Goal

Replace the simplified `mintRatePerDot` owner-set storage variable
with the two-layer emission mechanism:

- **Outer (baked, non-governable)** — daily emission cap halves every
  7 calendar years. Epoch budgets [47.5M, 23.75M, 11.875M, ...] sum
  to exactly 95M. Daily cap = `epoch_budget / 2555 days`.
- **Inner (permissionless dynamic adjustment)** — per-DOT rate adapts
  every ~1 day toward `daily_cap / observed_DOT_volume`. Hard-bounded
  [0.001, 200] DATUM/DOT. Max 2× change per adjustment period.
- **Per-claim mint** — clipped against remaining daily and epoch
  budgets; excess is forfeit.

Implements the cap-as-monetary-credibility commitment in TOKENOMICS
§1.4 ("Hard cap is non-governable").

## Out of scope

- **Tokenomics-spec sections that are separate features**, even though
  TOKENOMICS.md groups them under "Settlement-driven emissions":
  - §3.7(b) quality-threshold mint gate — separate task. Stub a
    `_meetsQualityThreshold` hook that always returns true; the real
    check belongs in claim validation, not the mint path.
  - §3.7(c) 7-day per-address ramp — separate task. Stub a
    `_rampFactor(address) → 10000` constant return; ramp logic is
    sybil-resistance, not emission curve.
  - §3.7(a) per-address daily cap — separate task. Default to
    `type(uint256).max` (effectively no cap).
  - Treasury skim (§3.6) — separate task. Default `treasurySkimBps = 0`.
- **Governance plumbing** for the few tunable parameters
  (`adjustmentPeriod`, `dustThreshold`, `perAddressDailyCap`,
  `treasurySkimBps`). Land as owner-only setters in this task;
  `DatumParameterGovernance` wiring is a follow-up.
- **Migration of existing testnet state.** Alpha-4 contracts in
  production today have ~zero settled DATUM mint volume (alpha
  state, no real economic value per §1.6.x). We deploy fresh
  contracts and re-wire; no data migration needed.
- **DatumMintAuthority changes.** The mint authority already has the
  95M `MINTABLE_CAP` enforcement. Settlement plumbs into the existing
  `mintForSettlement` path — no changes to the authority contract.

## Branch strategy

One branch per stage. Each lands its own PR with green tests before
moving to the next.

```
feature/path-h-stage0   ← invariant tests on current placeholder
feature/path-h-stage1   ← epoch state machine + rollEpoch()
feature/path-h-stage2   ← daily cap state + cap clipping
feature/path-h-stage3   ← dynamic rate + adjustRate()
feature/path-h-stage4   ← integrate into settlement mint hook
feature/path-h-stage5   ← deploy.ts wiring + setup-testnet
feature/path-h-stage6   ← governance-tunable params (adjustment period etc.)
```

## Stage 0 — Invariant baseline on current placeholder (PREREQUISITE)

Capture the current behaviour of the flat-rate placeholder so we can
verify that switching to Path H mints **less** total (more scarce),
**clips at the cap**, and **never exceeds 95M cumulatively**.

**Files:**
- `alpha-4/test/datum-emission-baseline.test.ts` (NEW, ~120 LOC)

**Invariants to capture:**
- `mintRatePerDot` defaults to 19; can be raised up to MAX_MINT_RATE=100.
- Per-batch mint = `agg.total × mintRatePerDot / 10**10`.
- `mintForSettlement` reverts if `MINTABLE_CAP` is exceeded; settlement
  itself does NOT revert (try/catch). `DatumMintFailed` is emitted.
- Split is currently 55/40/5 (hardcoded via `datumRewardUserBps` etc).
- `dustMintThreshold` skips sub-dust mints silently.

**Acceptance:** New test file passes against current code; no source
changes. Commit message: `Baseline current DATUM emission invariants`.

**Effort:** ~1 session.

## Stage 1 — Epoch state machine + `rollEpoch()`

Add the outer halving layer: epoch tracking with permissionless
rollover. No daily cap or rate adjustment yet — that's Stage 2/3.

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` (MODIFY — add epoch state +
  rollEpoch). Bytecode size budget: this contract is already close to
  the EIP-170 limit. May need to relocate the mint logic to a separate
  `DatumEmissionEngine.sol` library/contract — decide at top of stage.
- `alpha-4/contracts/DatumEmissionEngine.sol` (NEW IF NEEDED — ~200 LOC)
- `alpha-4/test/datum-emission-epochs.test.ts` (NEW — ~150 LOC)

**State variables:**
```solidity
// Baked constants (non-governable)
uint256 public constant HALVING_PERIOD_SECONDS = 7 * 365 days;   // 7 calendar years
uint256 public constant DAYS_PER_EPOCH         = 2555;            // 7 × 365
uint256 public constant EPOCH_0_BUDGET         = 47_500_000 * 10**10;  // 47.5M DATUM
uint8   public constant TOTAL_EPOCHS           = 30;              // safety cap; geometric series

// Runtime state
uint8    public currentEpoch;             // 0..TOTAL_EPOCHS-1
uint256  public epochStartTime;           // unix seconds
uint256  public remainingEpochBudget;     // in 10^10 base units
uint256  public totalMinted;              // sum across all epochs

event EpochRolled(uint8 indexed newEpoch, uint256 epochBudget, uint256 carriedForward);
```

**Helper view: `scheduledBudget(epoch)` →**
- Returns `EPOCH_0_BUDGET / (2^epoch)` for `epoch < TOTAL_EPOCHS`.
- Returns `0` for `epoch >= TOTAL_EPOCHS` (terminal).

**Permissionless function:**
```solidity
function rollEpoch() external {
    require(block.timestamp >= epochStartTime + HALVING_PERIOD_SECONDS, "too early");
    uint256 carry = remainingEpochBudget;            // unused rolls forward
    currentEpoch++;
    epochStartTime = block.timestamp;
    remainingEpochBudget = scheduledBudget(currentEpoch) + carry;
    emit EpochRolled(currentEpoch, scheduledBudget(currentEpoch), carry);
}
```

**Initialization:** constructor sets `currentEpoch=0`,
`epochStartTime=block.timestamp`, `remainingEpochBudget=EPOCH_0_BUDGET`.
No `_initEmission()` separate from constructor — emission is implicit
from genesis-of-this-contract.

**Acceptance:**
- Roll-too-early reverts.
- Roll at exactly `epochStartTime + HALVING_PERIOD_SECONDS` succeeds.
- Sequential rolls produce budgets [47.5M, 23.75M, 11.875M, ...].
- Carry-forward: if `remainingEpochBudget = X` at roll, the new epoch
  starts with `scheduledBudget(epoch) + X`.
- After 30 rolls, scheduledBudget returns 0.

**Effort:** ~1-2 sessions.

## Stage 2 — Daily cap state + cap clipping

Add the per-day mint ceiling derived from the epoch budget. Clip
per-claim mint against `remainingDailyCap` and `remainingEpochBudget`.

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` or `DatumEmissionEngine.sol`
  (MODIFY — add daily cap state + clip logic)
- `alpha-4/test/datum-emission-daily-cap.test.ts` (NEW — ~180 LOC)

**State variables:**
```solidity
uint256 public dayStartTime;          // UTC-midnight of current day
uint256 public remainingDailyCap;     // in 10^10 base units
uint256 public dailyMinted;           // mints recorded this day (for observability)

event DayRolled(uint256 newDayStart, uint256 dailyCap);
```

**Helper view: `dailyCap()` →**
- Returns `scheduledBudget(currentEpoch) / DAYS_PER_EPOCH`.
- Note: does NOT use `remainingEpochBudget` — daily cap is derived from
  the **scheduled** budget so it's stable through the epoch even after
  partial drainage. This is the intended Bitcoin-style behaviour
  (the daily cap is the target, not the remaining quota).

**Internal day-rollover:** before every mint, check if UTC-midnight
has passed; if so, reset `remainingDailyCap = dailyCap()` and bump
`dayStartTime`. No permissionless trigger — embedded in the mint
path so the system can't be DoS'd into stale state.

```solidity
function _maybeRollDay() internal {
    uint256 currentDayStart = (block.timestamp / 1 days) * 1 days;
    if (currentDayStart > dayStartTime) {
        dayStartTime = currentDayStart;
        remainingDailyCap = dailyCap();
        dailyMinted = 0;
        emit DayRolled(currentDayStart, remainingDailyCap);
    }
}
```

**Clip logic** (called from the mint hook):
```solidity
function _clipMint(uint256 raw) internal returns (uint256 effective) {
    _maybeRollDay();
    effective = raw;
    if (effective > remainingDailyCap)    effective = remainingDailyCap;
    if (effective > remainingEpochBudget) effective = remainingEpochBudget;
    remainingDailyCap    -= effective;
    remainingEpochBudget -= effective;
    dailyMinted          += effective;
    totalMinted          += effective;
}
```

**Acceptance:**
- After 18,591 DATUM minted in epoch 0, daily cap is exhausted — next
  mint in same day clips to 0.
- At UTC midnight, daily cap resets to 18,591.
- Epoch budget tracking: cumulative across days within an epoch is
  bounded at epoch budget. (Daily cap × days remaining > remaining
  epoch budget is possible — the epoch-budget clip catches this.)
- `totalMinted` matches the sum of all minted amounts.

**Effort:** ~2 sessions (edge cases around UTC rollover + epoch
boundaries are subtle).

## Stage 3 — Dynamic rate + permissionless `adjustRate()`

Add the inner difficulty-adjustment layer. Rate adapts toward
`daily_cap / observed_volume` with anti-volatility clamps.

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` or `DatumEmissionEngine.sol`
  (MODIFY — add rate state + adjustRate function)
- `alpha-4/test/datum-emission-rate-adjust.test.ts` (NEW — ~200 LOC)

**Constants:**
```solidity
uint256 public constant MIN_RATE              = 1 * 10**7;      // 0.001 in 10^10 base
uint256 public constant MAX_RATE              = 200 * 10**10;   // 200 in 10^10 base
uint16  public constant MAX_ADJUSTMENT_RATIO  = 2;              // 2× max change per period
uint256 public constant INITIAL_RATE          = 19 * 10**10;    // 19 DATUM/DOT bootstrap
```

**State variables:**
```solidity
uint256 public currentRate;                       // DATUM per DOT, in 10^10 base
uint256 public lastAdjustmentTime;                // unix seconds
uint256 public cumulativeDotThisAdjustmentPeriod; // in planck DOT

// Governable (within hard bounds [1d, 90d])
uint64  public adjustmentPeriodSeconds;           // default 86400 (1 day)

event RateAdjusted(uint256 newRate, uint256 observedVolume, uint256 targetRate);
```

**Initialization:** constructor sets `currentRate = INITIAL_RATE`,
`lastAdjustmentTime = block.timestamp`,
`adjustmentPeriodSeconds = 86400`.

**Per-mint hook update:** track cumulative DOT for the period.
```solidity
// inside _processBatch, after agg.total is computed:
cumulativeDotThisAdjustmentPeriod += agg.total;
```

**Permissionless function:**
```solidity
function adjustRate() external {
    require(block.timestamp >= lastAdjustmentTime + adjustmentPeriodSeconds, "too soon");

    uint256 observedVolume = cumulativeDotThisAdjustmentPeriod;
    uint256 periodBudget   = dailyCap() * adjustmentPeriodSeconds / 1 days;

    uint256 targetRate;
    if (observedVolume > 0) {
        // periodBudget and currentRate are in 10^10 base; observedVolume is in planck.
        // Target = periodBudget × 10^10 / observedVolume keeps the rate in 10^10 base.
        targetRate = periodBudget * 10**10 / observedVolume;
    } else {
        // No observation: push toward MAX_RATE for next period.
        targetRate = currentRate * MAX_ADJUSTMENT_RATIO;
    }

    // Anti-volatility clamps
    uint256 minNext = currentRate / MAX_ADJUSTMENT_RATIO;
    uint256 maxNext = currentRate * MAX_ADJUSTMENT_RATIO;
    if (targetRate < minNext) targetRate = minNext;
    if (targetRate > maxNext) targetRate = maxNext;

    // Absolute floor and ceiling
    if (targetRate < MIN_RATE) targetRate = MIN_RATE;
    if (targetRate > MAX_RATE) targetRate = MAX_RATE;

    emit RateAdjusted(targetRate, observedVolume, currentRate);
    currentRate                          = targetRate;
    lastAdjustmentTime                   = block.timestamp;
    cumulativeDotThisAdjustmentPeriod    = 0;
}
```

**Acceptance:**
- Volume = 0 → rate doubles (clamped at `min(2×current, MAX_RATE)`).
- Volume below `daily_cap / MAX_RATE` → rate clamps at MAX_RATE.
- Volume above `daily_cap / MIN_RATE` → rate clamps at MIN_RATE.
- Steady-state observed volume → rate converges to
  `daily_cap × 10^10 / observed_volume` within anti-volatility bounds.
- `adjustRate()` is permissionless; anyone can call after the period.
- Calling early reverts.

**Effort:** ~2 sessions.

## Stage 4 — Integrate into settlement mint hook

Replace the current flat-rate mint formula with the Path H pipeline.
This is the smallest stage in LOC but the most thorough in testing
because it changes the live mint path.

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` (MODIFY — change mint hook
  at line ~1272 in `_settleSingleClaim` / `_processBatch`)
- `alpha-4/test/datum-emission-mint-path.test.ts` (NEW — ~250 LOC)

**Before (current):**
```solidity
if (mintAuthority != address(0) && agg.total > 0) {
    uint256 totalMint = (agg.total * mintRatePerDot) / (10**10);
    if (totalMint >= dustMintThreshold) {
        uint256 userMint        = (totalMint * uint256(datumRewardUserBps))      / 10000;
        ...
        try IDatumMintAuthority_Settle(mintAuthority).mintForSettlement(...) {} catch {
            emit DatumMintFailed(...);
        }
    }
}
```

**After (Path H):**
```solidity
if (mintAuthority != address(0) && agg.total > 0) {
    cumulativeDotThisAdjustmentPeriod += agg.total;
    uint256 rawMint = (agg.total * currentRate) / (10**10);
    uint256 effectiveMint = _clipMint(rawMint);  // Stage 2 helper
    if (effectiveMint >= dustMintThreshold) {
        uint256 userMint       = (effectiveMint * uint256(datumRewardUserBps))      / 10000;
        uint256 publisherMint  = (effectiveMint * uint256(datumRewardPublisherBps)) / 10000;
        uint256 advertiserMint = effectiveMint - userMint - publisherMint;
        try IDatumMintAuthority_Settle(mintAuthority).mintForSettlement(...) {} catch {
            emit DatumMintFailed(...);
        }
    }
}
```

**Remove:**
- `mintRatePerDot` state variable (replaced by `currentRate`)
- `setMintRate(newRate)` function (rate is now adaptive)
- `MAX_MINT_RATE` constant (replaced by MAX_RATE)

**Acceptance:**
- Total mint over a simulated year ≤ `dailyCap × 365` (rate adapts).
- Mint when daily cap is full → 0 effective mint, settlement still succeeds.
- Mint across epoch rollover triggers `EpochRolled` + uses new budget.
- Mint across day rollover triggers `DayRolled` + resets daily cap.
- Cumulative `totalMinted` is bounded ≤ sum of scheduled budgets so far.

**Effort:** ~2 sessions.

## Stage 5 — Deploy.ts wiring + setup-testnet

Update deployment scripts. Path H has no constructor params beyond
what's baked. Hardly any wiring.

**Files:**
- `alpha-4/scripts/deploy.ts` (MODIFY — remove `setMintRate` call,
  remove `MAX_MINT_RATE` reference if present)
- `alpha-4/scripts/setup-testnet.ts` (MODIFY — no longer needs to
  configure mintRate; emit a noop log line)
- `alpha-4/scripts/role-gas-report.ts` (MODIFY — drop the
  "implementation gap" warning callout in the DATUM section)

**Acceptance:**
- `npx hardhat run scripts/deploy.ts --network localhost` succeeds.
- Settlement deploys with currentRate = 19, currentEpoch = 0.
- Validation phase confirms epoch + rate state are sensible.

**Effort:** ~1 session.

## Stage 6 — Governance-tunable params

Make the small set of governable parameters reachable from
`DatumParameterGovernance`. Per TOKENOMICS §3.5 the governable
surface is:

- `adjustmentPeriodSeconds` — bounded [1d, 90d] (baked)
- `dustMintThreshold` — bounded [0, 1 DATUM] (baked)
- `perAddressDailyCap` — bounded [0, ∞] (sybil knob; not used in
  this task since §3.7a is out of scope, but plumb the setter
  for the follow-up task)
- `treasurySkimBps` — bounded [0, 1000] (sybil knob; not used in
  this task since §3.6 is out of scope, but plumb the setter
  for the follow-up task)

**Files:**
- `alpha-4/contracts/DatumSettlement.sol` (MODIFY — add bounded setters)
- `alpha-4/contracts/DatumParameterGovernance.sol` (MODIFY — add
  these four parameters to the whitelist)
- `alpha-4/test/datum-emission-governance.test.ts` (NEW — ~120 LOC)

**Acceptance:**
- Setters reject out-of-bound values with E11.
- ParameterGovernance proposals can adjust these params via timelock.
- Non-owner direct calls revert.

**Effort:** ~1 session.

## Implementation order rationale

Stages 1-3 build the state machinery without changing live behaviour.
Stage 4 flips the switch in the settlement hot path. This means a
buggy Stage 1-3 doesn't break settlement — the flat-rate hook keeps
working until Stage 4 cuts it over.

Stages 5-6 are pure plumbing (wiring + governance).

## Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| **Bytecode size**: `DatumSettlement.sol` may exceed EIP-170 24KB limit. | High | Decide at top of Stage 1: if size budget is tight, hoist emission logic into `DatumEmissionEngine.sol` as a separate contract; Settlement holds a reference. |
| **Rate convergence oscillation** under bursty volume. | Medium | The 2× anti-volatility clamp limits this. Test with synthetic bursty traffic to verify. |
| **UTC-midnight drift** due to block-time slop on Polkadot Hub. | Low | `block.timestamp` is monotonic on Hub; small drift is fine for daily-cap accounting. |
| **First-epoch initialization**: contract deployed mid-day means partial epoch 0 starts mid-cycle. | Low | Acceptable; the deploy block timestamp anchors the schedule. |
| **Test fixtures using flat rate** will break when `setMintRate` is removed. | Medium | Update fixtures in Stage 4 alongside the cutover; `role-gas-report.ts` already calls `setMintRate` via `setMintRate`. |
| **DatumMintAuthority cap interaction**: authority enforces 95M cap. Settlement's `totalMinted` and authority's are both authoritative — they should agree but drift is conceivable. | Medium | Either: (a) trust the authority and have Settlement track only for observability, or (b) Settlement caps locally and never tries to mint above its tracked total. Recommend (b) — defence in depth. |
| **Permissionless `rollEpoch()` / `adjustRate()` not called** in low-activity regimes. | Low | Both are cheap; testnet ops infra calls them on a cron. In permissionless networks, MEV searchers would call them for tiny tips (or out of altruism — gas cost is trivial). Document the assumption in the emission engine. |

## Testing strategy

Each stage has its own test file. The full pipeline gets an
integration test at Stage 4:

- `alpha-4/test/datum-emission-integration.test.ts` (~300 LOC)
  - Simulate 7-year horizon with monthly-batched settles
  - Verify: total mint ≤ 47.5M (epoch 0 budget)
  - Verify: rate adapts toward `cap / volume`
  - Verify: epoch rollover at year 7 produces 23.75M new budget
  - Verify: cumulative mint after 30 epochs ≤ 95M

Coverage target: 95% line coverage on `DatumEmissionEngine.sol`
(or the modified section of `DatumSettlement.sol`).

## Deployment migration

**Live alpha-4 deployment** (current Paseo state, commit 3e63508):
no real economic value at stake (per §1.6.x). Redeploy with the new
emission engine; existing campaigns/users continue working since the
mint path is non-critical (try/catch). Old mints stay valid.

**Pre-mainnet checklist:**
- Stages 0-6 all green.
- `npx hardhat test` — 977+ existing tests still green.
- Manual review: confirm `DatumMintAuthority.MINTABLE_CAP` is still
  95M and the wrapper/precompile wiring is intact.
- Run `scripts/role-gas-report.ts` and confirm DATUM section shows
  actual contract state instead of "implementation gap" callout.
- Audit pass — emission engine is a new contract; warrants a focused
  review even if the math is simple.

## Effort total

Across all six stages: ~10-12 sessions, depending on bytecode-size
decision in Stage 1. Most of the time is in test coverage (~60%) and
Stage 4 integration (~25%).

## Open questions to resolve before starting

1. **Hoist or in-line?** Should the emission state machine live in
   `DatumSettlement.sol` (saves a contract; risk of EIP-170) or a
   new `DatumEmissionEngine.sol` (cleaner separation; one more
   address to wire)? Default: hoist. Re-decide at Stage 1 if measured
   size is under budget.
2. **Daily cap derivation timing.** TOKENOMICS §3.4 says daily cap
   uses `scheduledBudget(epoch) / 2555`. We interpret "scheduled" as
   the initial budget, not the remaining-after-clip. Confirm this is
   the intended reading; alternative is `remainingEpochBudget /
   days_remaining_in_epoch`, which dampens emission as the epoch
   drains. Default: use scheduled (stable, predictable).
3. **Genesis epoch start.** Should `epochStartTime` align to a global
   schedule (e.g., genesis block of the protocol) or be set to the
   deploy timestamp? Default: deploy timestamp, since alpha-4 is
   pre-mainnet. Mainnet redeploy will use a different anchor.
4. **`MAX_RATE` units.** Spec says 200 DATUM/DOT (in human-readable);
   contract stores 10-decimal base units. Plan uses `200 * 10**10`
   which is 200 in human terms. Confirm.

These questions should be answered in a brief design sync before
Stage 0 begins. None should require touching code to resolve.
