# DatumIdentityVerifier

Groth16 Solidity verifier for the identity circuit. One public input
(`commitment`); one private witness (`secret`); the constraint
`Poseidon(secret) == commitment`. Lets a caller prove on-chain that
they own a specific commitment without revealing the underlying
secret.

Companion: [`task-zk-identity-verifier.md`](./task-zk-identity-verifier.md).

Structurally a sibling of `DatumZKVerifier` (the impression circuit
verifier) — same BN254 precompile-driven pairing check via 0x06,
0x07, 0x08 — but for a 1-public-input circuit instead of 7. Kept
standalone so future contracts that gate behavior on "the caller
owns commitment X" can reuse the primitive.

## What "verify identity" means

`verifyIdentity(proof, commitment) → bool`. Returns true iff:

- The VK has been set (`vkSet == true`).
- `proof.length == 256` (ABI-encoded `uint256[2] pi_a`, `uint256[4]
  pi_b`, `uint256[2] pi_c`).
- The Groth16 pairing equation evaluates to identity under the
  current VK and the supplied commitment.

A successful return is "the caller knows a secret whose Poseidon
preimage hashes to this commitment." It does NOT prove uniqueness
or freshness — the same proof can be replayed by any party that
also knows the proof bytes. Consumers (notably
`DatumStakeRootV2.challengeRootBalance` once balance-fraud is
implemented) layer freshness via per-call nonce binding.

## The VK is lock-once

`setVerifyingKey(alpha1, beta2, gamma2, delta2, IC0, IC1)` — owner-
only, reverts E01 if `vkSet`. The key is a one-shot artifact of the
trusted setup. To rotate, deploy a new verifier and re-wire
`DatumStakeRootV2.setIdentityVerifier` (which uses
`plumbingLocked`-gated swap rather than per-call lock-once
specifically to support that pattern).

Run `node scripts/setup-zk-identity.mjs` to regenerate the VK
calldata. Production requires a multi-party MPC ceremony (mainnet
blocker per `MAINNET-DEFERRED §6`); testnet uses a single-party
setup.

## VK shape

```solidity
struct VerifyingKey {
    uint256[2] alpha1;   // G1
    uint256[4] beta2;    // G2 in EIP-197 order [x_im, x_re, y_im, y_re]
    uint256[4] gamma2;   // G2
    uint256[4] delta2;   // G2
    uint256[2] IC0;      // G1 — constant term
    uint256[2] IC1;      // G1 — commitment coefficient
}
```

The single `IC1` entry corresponds to the single public input. The
`_acc` helper computes `vkx + IC1 * commitment` via precompile-driven
multiplication (0x07) and addition (0x06). The public input is
reduced modulo `SCALAR_ORDER` before multiplication.

## Trust model

- The VK is the trust root. Whoever ran the trusted setup knows the
  toxic waste. MPC ceremony for production; single-party for
  testnet.
- Once `vkSet`, no admin path can rotate the VK — only contract
  replacement.
- The verifier is stateless beyond the VK; same input → same output,
  no nonces, no replay protection. That's the caller's responsibility.

## Upgrade

Upgradable via DatumGovernanceRouter, but the natural rotation path
is a fresh deploy + re-wire (since the VK itself is lock-once). The
`_migrate` override would have nothing meaningful to migrate.
