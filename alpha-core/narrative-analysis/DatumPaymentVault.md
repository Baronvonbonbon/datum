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

## G-8 close (2026-05-20): time-locked recovery address

Closes `gaps-in-checks-and-balances.md` G-8 (no emergency unstake
for users). Users register a recovery address (typically a cold
wallet) via `setRecoveryAddress(addr)`. The registration does NOT
take immediate effect — it activates after `recoveryDelayBlocks`
(~24h default, bounded `[6h, 30d]`).

Once active, anyone can call `emergencyWithdraw(originalAccount)`
and BOTH `userBalance` and `publisherBalance` of the original
account flow to the registered recovery address. Permissionless
caller: anyone can trigger, but funds always go to the registered
recovery. This means the recovery wallet doesn't need to spend gas
itself — a friend, a watcher service, or even a bot can fire it.

One-shot semantics: after `emergencyWithdraw` fires, the recovery
state clears (both `recoveryAddress[user]` and
`recoveryEffectiveBlock[user]` reset to zero). To rotate the recovery
again, the user must re-register, which restarts the delay.

### Anti-attack property

If an attacker steals the hot key, they can:

1. Try to redirect recovery to their own address — but
   `setRecoveryAddress` always restarts the delay. They'd have to
   wait the full window (~24h default) before they could call
   `emergencyWithdraw`.
2. During that window, the legitimate user — having detected the
   compromise off-chain — calls `cancelRecoveryAddress`, which
   wipes the pending state.

This works as long as: (a) the legitimate user notices the
compromise within the delay window, and (b) the legitimate user
still has the hot key to issue the cancel. If the attacker has
already exfiltrated the key AND the user is unaware, the protocol
can't help — but neither can any on-chain recovery system without
some out-of-band trust assumption.

### Why permissionless caller, fixed recipient

Two design choices:

- **Anyone can call `emergencyWithdraw`.** Defeats the "cold
  wallet has no gas" problem common in recovery scenarios — the
  user's friend or a third-party watcher can fire the recovery.
- **Funds always go to the registered recovery.** Even if a hostile
  party calls `emergencyWithdraw`, they can't redirect — the recovery
  address mapping is the sole recipient. The hostile party just
  burns their own gas with no benefit.

### Doesn't apply to (yet)

- `DatumTokenRewardVault` — ERC-20 side-rewards. Same pattern could
  be added; not a launch blocker since DOT credits are the
  higher-value user asset.
- Conviction-locked governance votes — those have their own lockup
  semantics. The user is the only one who can withdraw post-lockup;
  no equivalent recovery mechanism exists there yet.

### Parameter governance

`setRecoveryDelayBlocks(blocks_)` is owner-only, bounded to
`[MIN_RECOVERY_DELAY = 1440 (~6h), MAX_RECOVERY_DELAY = 432000 (~30d)]`.
Default 14400 (~24h). The bound is tight on both sides — too short
and the user can't react; too long and legitimate recovery becomes
painful.

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
