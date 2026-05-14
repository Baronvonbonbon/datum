# DatumInterestCommitments

The simplest contract in the protocol — 33 lines. Each user publishes a
single bytes32 Merkle root over their chosen interest-category set. The
ZK circuit proves the campaign's `requiredCategory` is a leaf under
this root, without revealing the rest of the user's interest set.

## Storage

```
interestRoot[user]   — current commitment (bytes32)
lastSetBlock[user]   — block of last update
```

## The single mutator

`setInterestCommitment(bytes32 root)`. Public; the user is `msg.sender`.
Idempotent — calling again overwrites. Setting to `bytes32(0)` clears.

## Why this is a contract instead of a UI convention

Two reasons:

1. **The commitment must be on-chain** for the ZK circuit to verify
   it. The proof's pub5 is `interestRoot[user]`, which the verifier
   reads from this contract via ClaimValidator.
2. **`lastSetBlock` is needed for the M-8 audit's age-gate.** A fresh
   commitment can't be used in a proof for `minInterestAgeBlocks`
   blocks, defeating reactive last-second swaps. This requires the
   contract to track when each user last updated.

## What it doesn't enforce

- No taxonomy. The contract accepts any bytes32 as the root. The
  meaning of "interest categories" is entirely off-chain — wallets and
  the extension know the canonical category list (16 categories in a
  4-level Merkle tree per spec), and they construct the user's
  commitment from those.
- No reveal. The full set is never on-chain. The user reveals
  individual leaves via ZK proofs as needed.
- No multi-set. One commitment per user. To "change preferences", the
  user updates the commitment (and waits for the age gate to clear).

## Trade-off: rotation friction

A user who decides to subscribe to a new category (say, "Sports") has
to:
1. Generate a new full interest tree off-chain including Sports.
2. Call `setInterestCommitment(newRoot)`.
3. Wait `minInterestAgeBlocks` (100 blocks = ~10 minutes) before any
   proof against the new commitment will verify.

That's deliberate. Without the wait, a user could "subscribe just in
time" to whatever the highest-paying campaign requires. The wait makes
preferences sticky.

## Why the protocol doesn't store the leaf list

If the protocol stored your full interest set on-chain, it would
*publicly leak* your interests — defeating the privacy property the ZK
proof is trying to provide. By storing only the commitment (Merkle
root), the protocol can verify membership without seeing what's in the
set.

## A worked example

```
Alice cares about: tech, finance, gaming
Alice's wallet builds a 4-level Merkle tree:
  leaves = [keccak("tech"), keccak("finance"), keccak("gaming"), 0, 0, ...]
  root = keccak(...) → e.g. 0xabc123...
Alice calls setInterestCommitment(0xabc123...)
Block N.
Campaign C requires category "tech" (keccak("tech") = 0xdef...)
At block N+100:
  Alice's wallet generates ZK proof showing keccak("tech") is in the tree
  under root 0xabc123, plus all the other Path A checks.
ClaimValidator verifies the proof; settlement proceeds.
```

The campaign learns Alice was interested in `tech` only because she
chose to claim. Other categories remain private.
