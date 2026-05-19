# DatumStakeRoot

**V1, kept in-tree as the legacy reference.** Per-epoch Merkle root
commitments over user-stake leaves. The off-chain root builder reads
`DatumZKStake.staked(user)` and constructs leaves of the form
`Poseidon(userCommitment, datumBalance)`; the root is committed here
via an N-of-M reporter threshold.

> **Successor:** [`DatumStakeRootV2.md`](./DatumStakeRootV2.md) replaces
> the owner-managed reporter set with a permissionless bonded
> mechanism + phantom-leaf fraud proofs. The two contracts coexist
> during migration via the dual-source oracle wiring described in
> [`stakeroot-shadow-mode.md`](./stakeroot-shadow-mode.md);
> `DatumZKVerifier` reads from whichever pointer governance has
> wired. Flipping the pointer is the cutover. See
> [`migration-stakeroot-v1-to-v2.md`](./migration-stakeroot-v1-to-v2.md)
> for the migration plan.

## Why epoched roots

The ZK proof needs to commit to *which* stake snapshot it was generated
against. Continuous on-chain updates would invalidate every in-flight
proof on every change. Epoching solves it: each root sits stable for an
epoch, and users with witnesses against that root have time to submit
proofs before the next epoch.

`LOOKBACK_EPOCHS = 8` — a root committed at epoch `e` remains valid
(satisfies `isRecent`) for the next 8 epochs. That's the grace window
users have to use a slightly-stale witness before regenerating.

## Reporter threshold

```
isReporter[addr]     — reporter membership (owner-managed)
reporters[]          — enumerable list
threshold            — N in N-of-M
```

Reporters off-chain agree on the leaf set and root. Each submits their
own on-chain `commitStakeRoot(epoch, root)`. The contract counts
distinct approvals via a per-proposal `voted[addr]` mapping. When
approvals ≥ threshold, the proposal finalises: `rootAt[epoch] = root`.

## M-1 audit: first-finalised-wins

Originally the contract allowed *overwriting* a finalised root if a
different proposal for the same epoch later reached threshold. The
audit identified the oscillation surface: an in-flight proof against
the displaced root would silently invalidate.

The M-1 fix: once `rootAt[epoch] != 0`, no further proposals for that
epoch can finalise. Off-chain reporters who disagree must correct via
a *later* epoch, not by overwriting.

## L-4 audit: threshold clamp on removeReporter

Removing a reporter that brings `reporters.length` below `threshold`
would permanently stall the contract — no proposal could ever finalise
again. The fix: `removeReporter` auto-clamps `threshold` down to the
new reporter count.

## Authorization

- `addReporter`, `removeReporter`, `setThreshold` — owner only
  (Timelock in production).
- `commitStakeRoot` — reporter only.
- `rootAt`, `isRecent`, `reporterCount` — public reads.

## Why not on-chain leaf maintenance

The leaf set could conceivably be maintained on-chain, with every
deposit / withdrawal updating the Merkle tree directly. Two reasons
against:

1. **Cost.** Each leaf update requires `log N` SSTOREs to update the
   Merkle path. With many users, every stake/unstake becomes
   prohibitively expensive.
2. **Off-chain witness generation.** The user needs the Merkle path to
   generate the proof. Doing this off-chain is straightforward; doing it
   on-chain requires either witness emission (events) or a separate
   read-side index.

Epoched off-chain root commitment is the standard pattern for ZK-Merkle
gates (used by Tornado Cash, Semaphore, etc.) and inherits all their
design rationale.

## Failure modes

- **Reporter cabal:** N reporters could collude on a fake root that
  includes a sybil leaf. Mitigation: reporters are independent parties
  (e.g. one team, one community member, one trusted oracle), and the
  on-chain root is auditable — anyone with the leaf list can verify it.
- **Reporter outage:** if more than M-N reporters go down, no new roots
  finalise. The 8-epoch lookback gives a buffer; beyond that, stake
  gate proofs start failing and ZK-gated campaigns can't settle.
  Governance can lower `threshold` to restore liveness at the cost of
  trust assumptions.

## Why N-of-M, not single

A single reporter is a single point of failure (and a single point of
malice). N-of-M provides defense in depth without the on-chain
complexity of a full consensus algorithm. The reporters run off-chain
and submit their approvals independently; the contract just counts.
