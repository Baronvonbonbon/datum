# DatumStakeRootV2

Permissionless bonded-reporter Merkle root oracle for ZK Path A.
Replaces the owner-managed N-of-M reporter set in V1 with a
stake-bonded permissionless mechanism. Anyone with ≥
`reporterMinStake` DOT can propose roots; threshold-of-bonded-stake
approvers finalize; phantom-leaf fraud is caught by anyone via the
commitment registry.

Companion docs:
- [`proposal-stakeroot-optimistic.md`](./proposal-stakeroot-optimistic.md)
  — design rationale
- [`task-stakeroot-v2-implementation.md`](./task-stakeroot-v2-implementation.md)
  — implementation plan
- [`migration-stakeroot-v1-to-v2.md`](./migration-stakeroot-v1-to-v2.md)
  — coexistence + migration
- [`stakeroot-shadow-mode.md`](./stakeroot-shadow-mode.md)
  — dual-source oracle wiring during transition
- [`DatumStakeRoot.md`](./DatumStakeRoot.md) — V1, kept in tree as
  the legacy reference

## What the V2 design wins

V1's failure mode: a captured owner could swap the reporter set,
push fraudulent roots, and no permissionless party could challenge.
V2 inverts the threat model:

- **Reporters self-bond.** No owner-controlled set. Anyone meeting
  the stake floor can join.
- **Stake-weighted finalization.** Proposals finalize when approving
  stake exceeds `approvalThresholdBps` of total active bonded stake.
- **Permissionless challenge.** Phantom-leaf fraud is provable by
  any party with a registered commitment and the right Merkle proof.
  Fraudulent reporters lose their stake; the challenger receives
  `slashedToChallengerBps` of the slash.
- **Stake-bonded commitment registry.** Every commitment costs
  `commitmentBond` to register. Sybil minting of phantom leaves
  becomes economically bounded — no longer free.

## Three fraud-proof modes

Only one is shipped; two are deferred behind the ZK identity verifier.

1. **Phantom leaf — SHIPPED.** Tree contains a commitment that was
   never registered. Anyone proves: "here's a Merkle proof for some
   leaf in your finalized root; that commitment isn't in the
   registry." Slashes the proposer + approvers.
2. **Balance fraud — DEFERRED.** Leaf claims wrong balance for a
   real user. Challenger needs ZK proof of commitment ownership (so
   they can prove "this commitment is mine; the claimed balance
   doesn't match my actual DATUM balance"). Requires
   `DatumIdentityVerifier` to be live, plus the SNAPSHOT_MIN_AGE /
   SNAPSHOT_MAX_AGE recency windows.
3. **Exclusion fraud — DEFERRED.** User's registered commitment is
   missing from the root. Same ZK ownership proof requirement as
   balance fraud.

## State

Reporters:

- `reporterStake[address] → (amount, joinedAtBlock, exitProposedBlock)`.
  `exitProposedBlock = 0` means active.
- `reporterList[]` + `_reporterIndex[]` for iteration.
- `totalReporterStake` — sum of active (non-exit-proposed) stake.
  Audit-5 H3 fix: `_slashProposer` only decrements this for
  reporters who have NOT exit-proposed (otherwise the decrement
  would underflow because `proposeReporterExit` already removed
  their voting weight).

Roots:

- Proposed root → proposer + bond + snapshot block + approving
  stake set + challenge deadline.
- Latest finalized root → consumed by `DatumZKVerifier` (V2 shadow
  mode) for ZK Path A proofs.

## Lifecycle

```
proposeRoot ──► [challenge window] ──► finalize / fail / be slashed
     │                                       │
     │   approveRoot from N reporters        │
     │                                       │
     │   challengePhantomLeaf can fire       │
     │   during the window                   │
     ▼                                       ▼
  Proposed                              Finalized / Slashed
```

`proposeRoot(snapshotBlock, root, batchHash, proposerBond)`:

- Snapshot block must be in `[block.number - SNAPSHOT_MAX_AGE,
  block.number - SNAPSHOT_MIN_AGE]` (recency window for future
  balance-fraud challenges).
- `proposerBond` required upfront.
- Sets challenge deadline at `block.number + challengeWindow`.

`approveRoot(rootId)`: any active reporter adds their stake to the
approving set.

`finalize(rootId)`: anyone after the challenge deadline. Sums
approving stake; requires `>= approvalThresholdBps * totalReporterStake
/ 10000`. Refunds bonds, marks root finalized.

`challengePhantomLeaf(rootId, proof, leaf)`: anyone with a Merkle
proof for a leaf whose commitment isn't in the registry. Slashes
proposer + approvers per the bps params.

## Bounds and ceilings

| Param | Ceiling |
|---|---|
| `approvalThresholdBps` | 9900 (99%) |
| `challengeWindow` | 1.2M blocks (~84d) |
| `reporterExitDelay` | 1.2M blocks (~84d) |
| `slashedToChallengerBps` | 10000 (100%) |
| `slashApproverBps` | 5000 (50%) |

`MAX_SLASH_APPROVER_BPS = 5000` keeps approvers from being fully
wiped on a single fraud — the lookback (`LOOKBACK_EPOCHS = 8`) is
the multiplier that compounds if an approver is repeatedly caught.

## Exit flow

`proposeReporterExit()` zeros the reporter's voting weight
(decrements `totalReporterStake`) and starts the exit delay. After
`reporterExitDelay` blocks, `exit()` returns the stake. Slash applies
during the delay window — exit-propose isn't a slash escape.

L3 (audit-pass-5): if EVERY reporter exits, `totalReporterStake = 0`
and `approvedStake * 10000 >= 0` is trivially true. A proposer
could finalize their root alone. Documented as a graceful-degradation
edge — the challenge window still applies, so a fraudulent root in
this scenario is still catchable. Operators must monitor
`totalReporterStake` and bring up new reporters before it drops to
zero.

## Shadow mode coexistence

The system can run V1 and V2 in parallel during migration. See
`stakeroot-shadow-mode.md` for the dual-source oracle wiring.
ZKVerifier reads from whichever pointer governance has wired;
flipping the pointer is the cutover.

## Governance surface

- **`setReporterMinStake` / `setReporterExitDelay` /
  `setApprovalThresholdBps` / `setChallengeWindow` /
  `setProposerBond` / `setChallengerBond` /
  `setSlashedToChallengerBps` / `setSlashApproverBps`** —
  owner-only, `whenNotFrozen`, bounded by their respective ceilings.
- **`setCommitmentBond(amount)`** — owner-only, `whenNotFrozen`.
- **`setDatumToken(addr)`** — owner-only, lock-once via `AlreadySet`.
  Wired to the production DATUM ERC-20 (mainnet blocker:
  currently `address(0)` per `MAINNET-DEFERRED §5 line 648/662`).
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Permanent.

## Trust assumptions

- The stake floor `reporterMinStake` is the Sybil bound.
- Phantom-leaf challenges require a registered commitment, which
  cost `commitmentBond` to register. This bounds the cost of
  generating false positive challenges.
- Audit-5 L5 documents the proposeRoot `epoch > latestEpoch` quirk
  — a proposer can leap forward, leaving intermediate epochs forever
  unfillable. Mitigated by the off-chain builder discipline and the
  challenge window (a non-contiguous root that's also fraudulent is
  catchable).

## Upgrade

Upgradable via DatumGovernanceRouter. State migration is non-trivial
(reporter list, stake amounts, proposed roots, finalized history,
commitment registry). A `_migrate` override would need to copy the
reporter set and pending-state mappings.
