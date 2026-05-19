# PaseoSafeSender

A native-DOT transfer helper that defeats the Paseo eth-rpc denomination
bug. Every contract that sends DOT inherits this and uses `_safeSend(to,
amount)` instead of raw `.call{value:}("")`. 84 lines.

## The bug it fixes

Paseo's eth-rpc gateway (the EVM compatibility shim sitting between
Ethereum-style RPC calls and the pallet-revive runtime) rejects any
transaction whose `value` satisfies `value % 10^6 >= 500_000`. The
trailing 10⁶ planck must fall in the "low half" of the range, or the
gateway returns an error and the transaction never lands.

This rejects ~half of all otherwise-valid amounts. Without mitigation,
every DOT-paying contract would randomly revert depending on the
amount.

## The fix

Two-part strategy:

1. **In-range amounts** (`value % 10^6 < 500_000`) are sent verbatim
   via a normal `.call{value:}`.
2. **Out-of-range amounts** are split: the contract sends
   `value - (value % 10^6)` (rounded down to the nearest 10⁶) and
   stashes the remainder in `pendingPaseoDust[recipient]`. The
   recipient pulls accumulated dust later via `claimPaseoDust`.

Recipients never lose value — every fraction is recoverable. Worst case
is a ~999,999-planck (≈0.0001 DOT) lag until the recipient bothers to
claim.

## State per-contract, not global

Each contract that inherits has its own `pendingPaseoDust` mapping. The
mapping is keyed by recipient EOA; the value is the accumulated dust on
this specific contract.

So Alice might have:
- `paymentVault.pendingPaseoDust(Alice) = 100_000 planck`
- `governanceV2.pendingPaseoDust(Alice) = 250_000 planck`

She pulls each separately via `paymentVault.claimPaseoDust()` /
`governanceV2.claimPaseoDust()`. Annoying for the user but trivial for
the UI to aggregate.

## ReentrancyGuard inheritance

`PaseoSafeSender` itself inherits `ReentrancyGuard`. The `claimPaseoDust`
path is `nonReentrant`; the internal `_safeSend` is not (it's called
from already-`nonReentrant` external functions in the inheriting
contracts).

## Constants

```
PASEO_UNIT = 10**6
PASEO_REJECT_THRESHOLD = 500_000
```

Both internal. Tuned to the specific gateway behavior; if Paseo fixes
the bug upstream, these constants can be lowered (or removed entirely)
without affecting the safe-send semantics.

## Why not just always round down

You could round down universally and stash *every* fractional remainder.
Cleaner code, more dust calls. The two-path version is a gas optimisation:
half the time the amount is in-range and a single transfer completes
without touching `pendingPaseoDust`.

## Mainnet relevance

On real Polkadot Hub (mainnet), the eth-rpc gateway should be fixed.
At that point `_safeSend` becomes a wrapper around a normal `.call`
with no special handling. The dust path remains functional for any
historical pending dust but stops accumulating new entries.

## What it doesn't handle

- ERC-20 transfers. Those go through SafeERC20.
- Contract recipients that revert. `_safeSend` uses a raw `.call`, so a
  reverting recipient causes the parent call to revert. For
  pull-payment paths where this matters, the inheriting contract
  queues the amount internally rather than calling `_safeSend` directly
  (e.g. ChallengeBonds' `pendingBondReturn`).
