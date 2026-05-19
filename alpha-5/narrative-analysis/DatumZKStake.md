# DatumZKStake

Path A's anti-sybil mechanism: users deposit canonical DATUM here, and the
off-chain stake-root builder reads `staked(user)` to construct the Merkle
leaves that back the ZK gate. Withdrawal carries a 30-day lockup that
resets on every new request — a sybil farm can't churn personas faster
than the lockup allows.

## Why deposit-based, not balance-based

The naive approach would have the stake-root builder read raw DATUM
balances. That's exploitable: a single wallet's DATUM can be shuffled
across N sybil personas in a single block to satisfy minStake N times.
By requiring a *deposit with a withdrawal lockup*, the stake becomes
*time-priced* rather than just capital-priced. Ten sybil personas means
10× minStake locked for AT LEAST `LOCKUP_BLOCKS` after the last persona's
last claim.

## LOCKUP_BLOCKS = 432_000

~30 days at 6 seconds per block. Immutable — chosen at deploy and not
governance-tunable. The design judgement: 30 days is the right friction
floor for sybil deterrence; a shorter lockup undermines the time-pricing,
a longer one strands legitimate users.

## User flow

```
1. setUserCommitment(Poseidon(secret))
   - One-time. Lock-once after first deposit: changing it would orphan
     the user's funds from the secret they prove knowledge of.
2. deposit(amount)
   - Standard ERC-20 deposit. Updates staked[user].
3. (off-chain) stake-root builder includes (commitment, staked) leaf in next root
4. (off-chain) user generates ZK proof referencing recent root
5. Submit claim — ClaimValidator's _verifyPathA reads the proof and root
```

To exit:

```
6. requestWithdrawal(amount)
   - staked[user] drops IMMEDIATELY (so subsequent stake roots reflect the
     lower balance)
   - amount added to pending, readyAt = block.number + 432_000
   - Crucially: any new request RESETS readyAt to block.number + 432_000
7. (wait 30 days)
8. executeWithdrawal()
   - Transfers the full pending amount, clears state
```

`cancelWithdrawal()` folds pending back into active stake. No penalty —
users may change their mind freely.

## Audit hardening (2026-05-13)

- **H-1 fix:** `slash()` reverts if `slashRecipient == address(0)`.
  Previously, slashing without a recipient set would orphan tokens in
  the contract.
- **H-2 fix:** `maxSlashBpsPerCall` (default 5000 = 50%) caps a single
  slash call at half the user's total slashable balance. Multi-call
  slashes still work; the cap is defense against a compromised slasher.

## Slash ordering

`slash(user, amount)` consumes from `pending` FIRST, then `staked`. R-H1
mirror across the stake-contract family. A user who anticipates a slash
and calls `requestWithdrawal` doesn't shield funds — their queued exit
is the first thing taken.

## Authority lock-once

- `isSlasher[addr]` — owner-managed until `lockSlashers()` is called.
  After locking, the slasher set is permanently fixed.
- `slashRecipient` — owner-set; H-1 requires non-zero at slash time.

The intended deploy sequence: set the slashRecipient, set the slasher(s),
verify on testnet, then `lockSlashers()`.

## Why hold canonical DATUM, not WDATUM

The off-chain root builder needs to read user stake balances and
construct the canonical Merkle tree. Storing those balances in *one*
EVM contract (this one) is simpler than reading from the Asset Hub
precompile every time. The contract is custodial: it holds canonical
DATUM and the user trusts this contract to release it back on withdraw.

## Pause behavior

None. Like other stake contracts, individual user actions (deposit,
request, execute, cancel) shouldn't be paused by global emergencies.
Slash is gated on the slashContract's own pause logic upstream.
