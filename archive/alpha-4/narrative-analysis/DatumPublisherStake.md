# DatumPublisherStake

Publishers stake native DOT here to back their honesty. The required stake
grows with cumulative settled impressions on a bonding curve, so a publisher
serving real volume is *forced* to keep more skin in the game. If
PublisherGovernance upholds a fraud proposal, this contract is what gets
slashed.

## The bonding curve

```
requiredStake = base + cumulativeImpressions × perImpressionPlanck
              (capped at maxRequiredStake, default 10⁴ DOT)
```

`base` and `perImpressionPlanck` are governance-set. The cap exists to keep
the curve from running away on a single publisher who serves billions of
impressions.

Settlement is the only contract authorized to call `recordImpressions(publisher, count)` —
the call updates `cumulativeImpressions`, which feeds the curve. This means
publisher stake adequacy is a function of *observed protocol activity*, not
a self-reported number. A publisher who tries to inflate their throughput
self-inflates their own stake requirement.

## Lifecycle

- `stake()` — payable. Publishers add native DOT to their balance.
- `requestUnstake(amount)` — drops `_staked[caller]` immediately so the
  publisher cannot continue claiming based on funds queued for withdrawal,
  and queues an `UnstakeRequest` with `availableBlock = block.number +
  unstakeDelayBlocks`. The remaining balance after the unstake must still
  meet `requiredStake` (E69) — partial drains below the bonding-curve floor
  are rejected.
- `unstake()` — after the delay, pulls the queued amount via `_safeSend`.
- `slash(publisher, amount, recipient)` — only callable by the `slashContract`
  (PublisherGovernance). R-H1 audit rule: consumes from `pendingUnstake`
  *first*, then `_staked`. A fraud-anticipating publisher cannot dodge slash
  by calling `requestUnstake`.

## H-2 audit fix: per-call slash cap

`maxSlashBpsPerCall` (default 5000 = 50%) caps a single slash call at half
the publisher's total slashable balance. A compromised slasher cannot drain
everyone in one call; legitimate full slashes need multiple calls or a
governance bump of the cap.

## Lock-once references

- `settlementContract` — only Settlement may call `recordImpressions`.
- `slashContract` — only PublisherGovernance may call `slash`.

Both lock-once. The contract's audit memo: a hot-swap on either would forge
impression counts (running up rivals' required stake) or forge slashes.

## isAdequatelyStaked

`isAdequatelyStaked(publisher)` is read by Settlement on every batch (FP-1
gate). A publisher whose balance has dropped below the curve cannot have
their claims settle. Practical implication: publishers must monitor their
own stake and top up before serving large volumes.

## Why a bonding curve

Linear `base + cumulative × perImp` is the simplest model that scales
risk with activity. Alternatives like a step function or a sqrt curve were
considered; linear was chosen for predictability — publishers can compute
their next required-stake threshold ahead of time and pre-fund.

The `maxRequiredStake` cap is a footgun-prevention: without it, a publisher
near `type(uint256).max / perImp` cumulative impressions could end up with
unreachable required stake. With it, the curve degenerates to a constant
once the cap is hit, and the slash-or-rotate decision becomes governance's
problem rather than an arithmetic one.

## Pause behavior

None directly. The slash entry point trusts the slashContract; stake/unstake
are publisher-self actions and shouldn't be paused by global emergencies
(publishers may legitimately want to exit during one).
