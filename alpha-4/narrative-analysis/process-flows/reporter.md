# Reporter (Stake Root)

Off-chain operator who commits stake-root Merkle commitments to
`DatumStakeRoot`. The cryptographic anchor for Path A — without honest
reporters, the ZK stake gate is meaningless.

## On-chain footprint

Each reporter is an EOA added to `DatumStakeRoot.isReporter` by the
contract's owner (Timelock in production). The set is enumerable via
`reporters[]`; the threshold `N-of-M` is governance-set.

A typical deployment uses 3–5 reporters with a 2 or 3 threshold.

## End-to-end flow

### Setup

1. **Be approved by governance.** `DatumStakeRoot.addReporter(addr)`
   is owner-only; the deploying team chooses an initial set, and
   future additions go through Timelock.
2. **Set up off-chain infrastructure:**
   - A node that reads `DatumZKStake.staked(user)` for every user
     (event-driven: `Deposited`, `WithdrawalRequested`,
     `WithdrawalExecuted`, `Slashed`).
   - A node that reads `DatumZKStake.userCommitment(user)` to map each
     user to their Poseidon commitment.
   - A Merkle tree builder (Poseidon-based — matches the
     impression.circom circuit's hash function).
   - A scheduler that triggers root commits per epoch.

### Per-epoch flow

```
1. Wait for epoch tick (epoch length is off-chain consensus among
   reporters — typically 1 day or 1 hour).
2. Snapshot DatumZKStake state at a deterministic block height.
3. Build leaves:
   leaf[i] = Poseidon(userCommitment[i], staked[i])
4. Build the Merkle tree, compute root.
5. (Off-chain) compare root with peer reporters. If they agree,
   proceed; if not, escalate (off-chain dispute).
6. Submit on-chain:
   DatumStakeRoot.commitStakeRoot(epoch, root)
7. Watch for StakeRootApproved events from peer reporters.
   When approvals reach threshold, StakeRootCommitted fires and the
   root is canonical for that epoch.
```

### Coordination

Reporters coordinate **off-chain** (the contract doesn't enforce
coordination). Typical mechanisms:

- A shared Signal/Slack channel where reporters announce intended
  roots.
- A Git-tracked reproducibility script: anyone can re-run the tree
  build against a snapshot and verify the root.
- A reference root server that one reporter runs publicly; others
  verify against it before signing.

### First-finalised-wins (M-1 audit)

Once `rootAt[epoch] != 0`, no further proposals for that epoch can
finalize. If reporters disagree mid-epoch and one cabal gets to
threshold first, the other cabal's root is rejected (`E22`). The
"correct" response to disagreement is:

1. Submit nothing; lose the epoch.
2. Coordinate off-chain to determine truth.
3. Submit a corrected root in the *next* epoch.

This is intentional: oscillating roots within an epoch would
invalidate in-flight ZK proofs. Better to lose one epoch's stake
gating than to silently invalidate user proofs.

### Threshold maintenance

If a reporter goes offline, `removeReporter` (owner-only, timelocked
in production) compacts the set. The L-4 audit fix auto-clamps
`threshold` down so the contract can't stall.

A failing-quorum scenario (more reporters offline than the threshold
allows) means **no new roots get committed**. Existing roots in the
`LOOKBACK_EPOCHS = 8` window remain valid; users with witnesses
against those keep claiming. Beyond 8 epochs, ZK-gated settlements
start failing reason 16. Governance must intervene to lower the
threshold or add replacement reporters.

### Honest-reporter assumptions

Reporters are trusted to:

- Read DatumZKStake state correctly.
- Not include phantom leaves (a leaf for an address that doesn't
  actually have stake) — this would let the leaf-owner pass the stake
  gate without locking DATUM.
- Not exclude legitimate leaves (a leaf for a real staker) — this
  would lock that staker out of the gate.

The threshold buys defense-in-depth against a single dishonest
reporter; it doesn't help against a cabal.

## Economic exposure

- **No on-chain stake.** Reporters aren't slashable in the current
  protocol. The accountability is reputational and political:
  governance can remove a misbehaving reporter, and the entire
  reporter set's identity is public.

- **A future protocol upgrade** might add reporter staking + slashing.
  Currently it's not wired; the cost of dishonesty is loss of position
  + public reputation damage.

## Who polices the reporter

- **Other reporters:** off-chain coordination + the threshold means
  one bad actor can't push a fraudulent root through alone.
- **The community:** anyone can re-run the tree build against
  `DatumZKStake` events and verify the committed root. A fraudulent
  root would be public on-chain and visibly wrong.
- **Governance (Timelock):** can `removeReporter(addr)` to evict.

## Trust assumptions placed on reporters

This is the protocol's **largest residual trust assumption** beyond
the ZK trusted setup. If reporters collude, they can fabricate stake
roots that include phantom personas — letting an attacker satisfy the
Path A stake gate without actually locking DATUM. The mitigations are
N-of-M threshold and public verifiability; the residual is that the
reporters are trusted parties.
