# DatumAdvertiserStake

Sibling to `DatumPublisherStake`, introduced in alpha-4 as CB4. Advertisers
lock native DOT to back accountability across every campaign they run. The
required stake grows with cumulative DOT *spent* through their campaigns:

```
requiredStake = baseStakePlanck + cumulativeBudgetSpentDOT × planckPerDOTSpent
              (capped at maxRequiredStake, default 10⁴ DOT)
```

`cumulativeBudgetSpentDOT` is measured in whole DOT (`amountPlanck / 1e10`);
sub-DOT spend is rounded down and doesn't advance the curve.

## Use case

`DatumCampaigns.createCampaign` consults `isAdequatelyStaked(msg.sender)`
when the AdvertiserStake reference is wired. An under-staked advertiser
cannot create new campaigns — though existing campaigns continue (no
retroactive enforcement). The intent: as an advertiser scales spend, they
must scale their skin in the game proportionally.

`DatumSettlement` records spend via `recordBudgetSpent(advertiser, amount)`
in a best-effort try/catch (CB4) — a misconfigured stake target cannot DoS
settlement. The stake reference on Settlement is lock-once.

## Slash path

`DatumAdvertiserGovernance` is the sole slasher; on fraud upheld, it calls
`slash(advertiser, amount, address(this))`. Like the publisher version:

- Consumes from `pendingUnstake` FIRST (R-H1 mirror) so an advertiser
  anticipating fraud action cannot shield funds via `requestUnstake`.
- H-2 audit fix: `maxSlashBpsPerCall` caps a single slash at half the
  total slashable balance (default 5000 bps). Multi-call slashes still
  possible.

## Lock-once references

- `settlementContract` — only Settlement may call `recordBudgetSpent`.
  Hot-swap would let an attacker forge spend on rivals, driving their
  required stake up to lock them out.
- `slashContract` — only AdvertiserGovernance may call `slash`. Hot-swap
  would allow unilateral slashing.

## Parameters (governance-set)

- `baseStakePlanck` — flat floor; every advertiser needs this regardless of spend.
- `planckPerDOTSpent` — slope of the curve.
- `unstakeDelayBlocks` — withdrawal lockup (must be > 0).
- `maxRequiredStake` — cap on the curve.

`setParams(base, perDOT, delay)` and `setMaxRequiredStake(cap)` are owner-only.
In the governance ladder the owner is the Timelock, so changes are gated by
the 48-hour delay.

## requiredStake() math

Watch the overflow check: `if (cum > headroom / perDOT) return cap`. This
prevents `base + cum * perDOT` from wrapping when an advertiser has truly
massive cumulative spend. Once `cum` exceeds the headroom, requiredStake
saturates at the cap.

## Why duplicate the publisher pattern

The bonding-curve / slash design works for both sides. Originally the
protocol only staked publishers; the alpha-4 CB4 addition was motivated by
the dual-sig path. If an advertiser is going to cosign claims into the
high-assurance settlement path, they should have on-chain accountability
that mirrors the publisher's. The advertiser-side stake also gives
AdvertiserGovernance a meaningful slash target — without it, the only
recourse against a fraudulent advertiser was campaign termination, which
mostly hurts the advertiser only on prospective spend.
