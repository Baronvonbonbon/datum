# DatumPaymentVault

The pull-payment vault that holds earned DOT. Settlement credits balances
here in three buckets — publisher, user, protocol — and recipients pull when
they want to. The vault never pushes DOT.

## The flow

1. `DatumBudgetLedger.deductAndTransfer` forwards DOT to this vault as part
   of every settled claim's deduction.
2. `DatumSettlement` calls `creditSettlement(publisher, pubAmt, user,
   userAmt, protocolFee)` — non-payable; just records the split into the
   three internal mappings.
3. Publisher / user calls `withdraw()` or the protocol calls
   `withdrawProtocol()` later. Pull pattern with ReentrancyGuard.

## Authorization

Only `settlement` may call `creditSettlement` — set lock-once. Hot-swap
would let an attacker credit arbitrary balances to themselves; freezing the
ref after first write closes that vector.

## Pull paths

- `withdraw()` — caller pulls their `publisherBalance + userBalance`. The
  contract zeroes both before transferring (CEI), uses `_safeSend` so dust
  caused by Paseo eth-rpc denomination rejection is queued for separate
  pickup, not lost.
- `withdrawProtocol(to)` — owner-only; pulls accumulated `protocolBalance`
  to the supplied address. The protocol's revenue stream.

## Why two balances per address

`publisherBalance` and `userBalance` are tracked separately even though
they're keyed by the same `address`. Reason: an EOA can be both a
publisher and a user (extension user runs ads on their own site, for
example). Splitting the buckets means the protocol can render distinct
"earned as publisher / earned as user" lines in UIs, and a future change
that vests one but not the other has the storage to do it.

## Pause check

Withdrawals do NOT check the pause registry. The design choice: a global
pause should never block users from pulling already-earned DOT — that turns
an emergency into a hostage scenario. Only credit (write) operations would
be gated by Settlement's own pause check, which is upstream.

## Receive function

The contract has no `receive`; DOT only arrives via the explicit
`BudgetLedger.deductAndTransfer` path. A misdirected raw transfer would
revert at the EVM level.

## Why it's separate

Originally co-located with Settlement; extracted to isolate value custody.
With Settlement at ~37KB bytecode, every kilobyte counts; pulling the vault
out also makes the trust surface around earned balances independently
auditable. Plus, you want the contract holding user funds to be as small and
boring as possible. This one is.
