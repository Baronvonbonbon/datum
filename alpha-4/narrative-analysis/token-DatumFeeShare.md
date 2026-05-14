# token/DatumFeeShare

Stake WDATUM, earn DOT. Implements the §2.1 cashflow utility: the
protocol's DOT-denominated fee stream (the 25% protocol cut on every
settlement) is streamed to WDATUM stakers pro-rata.

## The MasterChef/SushiBar pattern

Standard accumulator design:

```
state:
  totalStaked
  accDotPerShare       — cumulative DOT-per-share (scaled by 1e18)
  userStaked[user]
  userDebt[user]       — accDotPerShare snapshot at user's last action

on fee inflow (sweep):
  accDotPerShare += fee × 1e18 / totalStaked

on stake/withdraw:
  pending = (userStaked × accDotPerShare / 1e18) - userDebt
  pay out pending
  userDebt = userStaked × accDotPerShare / 1e18  (snapshot)
```

A same-block staker has `userDebt = userStaked × accDotPerShare / 1e18`
immediately after staking, so their `pending` is zero. No flash-stake
exploit possible.

## Fee inflow path

Two ways DOT enters this contract:

1. **Production:** `DatumPaymentVault` accumulates a `pendingFeeShare`
   counter as part of every settlement. Anyone can call `feeShare.sweep()`
   which pulls accrued DOT from PaymentVault via the
   `IDatumPaymentVault_FeeShare` interface and transitively calls
   `notifyFee()` to update the accumulator.
2. **Scaffold / testing:** anyone can call `fund() payable` to simulate
   fee inflow without the PaymentVault integration.

The sweep is permissionless — there's no central operator. A bot, the
user themselves, or any concerned community member can sweep when they
want their rewards updated.

## Withdrawal

`withdraw(amount)` — no lockup. The accumulator pattern handles
fairness on its own. Same-block deposit-then-withdraw earns nothing
because the userDebt snapshot makes pending zero.

`claim()` — claim accumulated DOT without changing stake.

## DOT payment via PaseoSafeSender

`_safeSend` is used for the DOT outflow. Stakers may see dust accumulate
in their `pendingPaseoDust[user]` bucket on this contract; they pull via
`claimPaseoDust()`.

## Owner role

Limited. Owner can:
- Configure the PaymentVault address (lock-once).
- Set the canonical WDATUM token (immutable in constructor).

That's it. The protocol intentionally has no levers here — fee share is
"deposit, accrue, claim", with the math doing the rest. Adding admin
levers would create opportunities to skim or freeze.

## What about WDATUM token-share dilution

New stakers DO dilute prospective fee share (each share is worth less
when more shares exist). But they do NOT dilute already-accrued
rewards: `userDebt` snapshots prevent retroactive claims. A user who
staked early earns their proportional share of every fee that came in
while they were staked, regardless of how many later stakers showed up.

## Withdrawal pause behavior

None. The contract has no pause check at all. The principle: staked
WDATUM and accrued DOT must always be claimable. An emergency pause on
this contract would be a hostage situation.

## Lock-once

`paymentVault` is set lock-once via owner. The WDATUM token address is
`immutable` (set at construction).

## Why a separate contract

You could imagine FeeShare living inside DatumPaymentVault. Reasons
against:
- PaymentVault's job is settlement payment custody. Mixing in long-term
  WDATUM staking accumulator state would balloon both its complexity
  and audit surface.
- FeeShare needs to be lock-free for WDATUM token deposits — different
  pause semantics from the vault.
- FeeShare may want a different governance / upgrade path in the long
  run; isolating it makes that possible.
