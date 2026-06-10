# Claim-bound ZK predicate — design note

The `Claim.proof[]` sidecar carries an optional `zkProof[8]` + `nullifier`. The validator
(`DatumClaimValidator._verifyClaimPredicate`) verifies it as a **general, optional
"prove a claim-bound predicate about the claimer" slot**, not a hardwired interest filter.

This note records (a) what shipped, (b) why it's dormant now, and (c) the deferred plan to
turn it into a multi-circuit registry — so the extension point is explicit and nobody has to
re-derive it.

## Background / why this is general now

The slot was originally one bundled circuit proving three things at once: a replay/sybil
nullifier, a private stake gate, and an **interest/tag-profile match**. Only the interest match
was tied to the second-price auction (skipped from the current deploy). The nullifier and stake
gate are auction-independent, and — more importantly — the *unique* value of a ZK slot in a
privacy ad protocol is proving **any** predicate about the claimer that can't be checked
on-chain without revealing it: proof-of-personhood (anti-bot), age/jurisdiction eligibility for
regulated categories, private-allowlist membership, the original interest match, etc.

The #2b slim work made this cheap to keep: the wire format already carries `zkProof` + `nullifier`
as opaque bytes in the sidecar (zero cost when absent), bound to the claim only through
`claimHash`. So **generalizing is a validator-side concern only** — no claim-struct, EIP-712, or
relay-path change. That's why the slot is kept rather than removed.

## What shipped (the general shape)

`_verifyClaimPredicate` builds the verifier's public inputs as:

```
pub[0] = claimHash    ── MANDATORY claim-binding prefix (proof can't be replayed onto
pub[1] = nullifier        a different claim; nullifier = Poseidon(secret, campaignId, windowId),
pub[2] = eventCount       also consumed by the on-chain NullifierRegistry)
pub[3..6] = predicate-defined suffix  ── whatever the campaign's circuit needs
```

- The mandatory prefix `[claimHash, nullifier, eventCount]` is the fixed security contract.
- The suffix `pub[3..6]` is produced by a swappable adapter, `_referencePredicateSuffix`,
  which currently implements the original stake + interest-category predicate
  (`[stakeRoot, minStake, interestRoot, requiredCategory]`).
- Interface today: `IDatumZKVerifier.verifyA(bytes proof, uint256[7] pubs)` — a fixed 7-input
  Groth16/BN254 verifier. 3 mandatory + 4 predicate slots.

**To swap the predicate** (without touching the wire format): replace `_referencePredicateSuffix`
+ the verifying key on `DatumZKVerifier`. The prefix stays fixed.

## Dormant by default

`DatumClaimValidator.zkVerifier == address(0)` (unwired). While unwired, `resolveBatchContext`
forces `requiresZk = false` for every campaign regardless of its `requiresZkProof` flag, so
`_verifyClaimPredicate` never runs. The current deploy leaves it unwired (no `setZKVerifier`
call, no production VK). The interest circuit's trusted setup is testnet single-party only;
mainnet would need an MPC ceremony per circuit anyway.

## Deferred: multi-circuit registry (build only when a 2nd predicate is greenlit)

Today there is one verifier slot. A general registry would let different campaigns require
different predicates. Sketch (NOT built — YAGNI until a concrete second circuit exists):

1. **Registry**: `circuitId → (verifyingKey/verifier, publicInputSchema)` on a
   `DatumZkCircuitRegistry` (or extend `DatumZKVerifier`).
2. **Campaign config**: a campaign declares `requiredCircuitId` + its public-input params
   (e.g. a Merkle root for allowlist, an age threshold, a personhood epoch). The
   `_referencePredicateSuffix` adapter becomes a per-circuit lookup.
3. **Validator**: always set `pub[0..2]` to the claim-binding prefix; fill `pub[3..6]` from the
   campaign's circuit params; dispatch to the circuit's verifier.
4. **Wire format**: unchanged — `zkProof` + `nullifier` already general. (If a circuit needs
   more than 4 suffix inputs, hash the extras into one slot, or widen `verifyA` to a
   variable-length `uint256[]` — a contained interface change.)

### Operational caveat
"General ZK tool for any purpose" within Groth16 = **one trusted-setup ceremony per circuit**.
That's real per-circuit operational weight; don't take it on speculatively. Truly drop-in
arbitrary circuits without per-circuit ceremonies would mean a universal-setup system
(PLONK/Halo2) — a much larger swap, out of scope unless the circuit count grows enough to
justify it.

## Candidate predicates (auction-independent)

- **Proof-of-personhood** — strongest anti-sybil; bots are the core ad-fraud threat.
- **Age / jurisdiction eligibility** — regulated categories (alcohol, gambling) without revealing identity.
- **Private-allowlist membership** — "I'm in this campaign's private audience" without revealing which member.
- **Interest/tag match** — the original; revisit if interest-based targeting / the auction return.

## Removal criterion

Remove the slot (`zkProof` + `nullifier` + `_verifyClaimPredicate` + verifier wiring) only if
privacy-preserving claimer-predicates are decided **off the roadmap entirely**. The nullifier is
dead weight without a circuit proving `nullifier = Poseidon(secret, …)` — a user could otherwise
mint fresh nullifiers freely — so the two must be removed together.
