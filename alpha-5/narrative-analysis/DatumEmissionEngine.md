# DatumEmissionEngine

The Path-H emission curve (TOKENOMICS §3.3): outer 7-year halvings
with an inner Bitcoin-difficulty-style adaptive per-DOT rate. Hoisted
out of DatumSettlement (alpha-4 EIP-170). Plugged into
`DatumMintCoordinator` via `setEmissionEngine`; when wired, every
settled batch's emission is computed here and clipped against
remaining daily + epoch budgets.

See [`task-datum-emission-path-h.md`](./task-datum-emission-path-h.md)
for the original design doc.

## Two-layer model

**Outer (epochs).** Budgets halve every 7 calendar years.
`scheduledBudget(epoch) = 47.5M >> epoch` (10-decimal base units).
The 30-epoch sequence [47.5M, 23.75M, 11.875M, ...] sums to exactly
95M, matching `DatumMintAuthority.MINTABLE_CAP`. After 30 halvings
the scheduled budget returns 0 and emission permanently stops.

**Inner (daily cap + adaptive rate).** Each epoch's budget is divided
across 2555 days (7 × 365). The daily cap is stable through an epoch
even as the remaining budget drains — predictable for off-chain
consumers. The per-DOT rate adapts every `adjustmentPeriodSeconds`
(1 day default, bounded [1d, 90d]) toward `dailyCap / observed_DOT_volume`,
clamped between MIN_RATE (0.001 DATUM/DOT) and MAX_RATE (200
DATUM/DOT), and bounded by ±2× per adjustment for volatility control.

## Permissionless mechanics

Three external entrypoints anyone can call (with time gates):

- **`rollEpoch()`** — `whenNotFrozen`. Requires `block.timestamp >=
  epochStartTime + HALVING_PERIOD_SECONDS`. Increments `currentEpoch`;
  refreshes `epochStartTime`; sets
  `remainingEpochBudget = scheduledBudget(newEpoch) + carry` where
  `carry` is any unspent budget from the prior epoch.
- **`adjustRate()`** — `whenNotFrozen`. Requires `block.timestamp >=
  lastAdjustmentTime + adjustmentPeriodSeconds`. Calls `_maybeRollDay`
  (the daily-cap rollover), then computes:
  - `target = (periodBudget * 1e10) / observed` if `observed > 0`
  - `target = currentRate * 2` (push up toward MAX_RATE) if no volume
  - Clamped to `[currentRate / 2, currentRate * 2]` (anti-volatility)
  - Then to `[MIN_RATE, MAX_RATE]` (absolute bounds)
- **`computeAndClipMint(dotPaid)`** — gated to `msg.sender ==
  settlement`. Settlement here is the MintCoordinator (since it's
  what's wired). Adds `dotPaid` to the adjustment-period accumulator,
  rolls the day if needed, computes `raw = dotPaid * currentRate /
  1e10`, clips to `min(raw, remainingDailyCap, remainingEpochBudget)`,
  drains both buckets, returns the effective amount.

## State

- `currentEpoch` (uint8) — 0 at deploy, increments via `rollEpoch`.
- `epochStartTime`, `remainingEpochBudget` — outer-loop state.
- `dayStartTime`, `remainingDailyCap`, `dailyMinted` — inner daily
  state. `dayStartTime` is anchored to the UTC-midnight before the
  current block timestamp.
- `currentRate` — per-DOT mint rate in 10-decimal base units; init
  to `INITIAL_RATE` (19 DATUM/DOT) and adapts forever.
- `lastAdjustmentTime`, `cumulativeDotThisAdjustmentPeriod` — drive
  rate adjustment.
- `totalMinted` — defence-in-depth tally independent of
  `DatumMintAuthority.totalMinted`.

## Governance surface

- **`setSettlement(addr)`** — owner-only, lock-once
  ("already set" on second call). Typically set to MintCoordinator.
- **`setAdjustmentPeriod(seconds_)`** — owner-only. Bounded by
  `ADJUSTMENT_PERIOD_MIN` (1 day) and `ADJUSTMENT_PERIOD_MAX` (90
  days). The only tunable param post-deploy; everything else is baked.

Notice that the budget cadence (`HALVING_PERIOD_SECONDS = 7 years`),
the day count (`DAYS_PER_EPOCH = 2555`), the epoch-0 budget
(`47.5M`), and `TOTAL_EPOCHS = 30` are all `constant`. The
monetary policy is hardcoded; changing any of those means deploying
a fresh contract and re-wiring MintCoordinator.

## Trust assumptions

- Settlement (MintCoordinator) is the sole writer of
  `cumulativeDotThisAdjustmentPeriod`, `remainingDailyCap`,
  `remainingEpochBudget`.
- A captured Settlement upgrade could submit fake `dotPaid` values
  to drain epoch budget; the worst case is "today's daily cap
  exhausts faster than expected", bounded by the daily clip.
- Permissionless `rollEpoch` / `adjustRate` are protected by time
  gates — there's no economic incentive to call them either too early
  (revert) or too late (no harm — they catch up).
- The 2× anti-volatility clamp and the absolute MIN/MAX rate bounds
  defend against pathological adjustments. Even with zero observed
  volume, the rate can only climb 2× per period.

## Upgrade

Engine is upgradable via DatumGovernanceRouter, but a state-preserving
migration is non-trivial: all the epoch + day + rate state would need
to copy. Acceptable replacement strategy:

1. Deploy new engine v2 with current `currentEpoch`,
   `remainingEpochBudget`, `currentRate` as constructor args.
2. Roll MintCoordinator.emissionEngine — but it's `lock-once` via
   `AlreadySet`. So the MintCoordinator itself would need to upgrade
   in tandem.

This is the kind of upgrade that needs OpenGov + a coordinated
roll-forward. The lock-once on `emissionEngine` is intentional friction.
