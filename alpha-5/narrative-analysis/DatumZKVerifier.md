# DatumZKVerifier

Groth16 verifier on BN254 with **7 public inputs**. Verifies the alpha-4
Path A circuit: `impression.circom` which proves a user (a) knows a secret
binding them to a DATUM-staked leaf in a recent stake root and (b) has the
required interest category in their committed interest tree.

## The 7 public inputs

```
pub0 = claimHash         (keccak256 of claim fields)
pub1 = nullifier         (Poseidon(secret, campaignId, windowId))
pub2 = impressions       (claim.eventCount; bounded to uint32 in-circuit)
pub3 = stakeRoot         (Merkle root over (commitment, stakedDatum) leaves)
pub4 = minStake          (campaign-set threshold the proof must satisfy)
pub5 = interestRoot      (user's committed interest set root)
pub6 = requiredCategory  (campaign-required category id; bytes32(0) = any)
```

All values are reduced `mod SCALAR_ORDER` (BN254 Fr) before pairing.

## Verifying key

`VerifyingKey` struct holds:

- `alpha1, beta2, gamma2, delta2` — the standard Groth16 G1/G2 elements.
- `IC0..IC7` — G1 coefficients (one constant + one per public input).

G2 elements are stored in EIP-197 order: `[x_imag, x_real, y_imag, y_real]`.
Off-chain snarkjs export must match.

## `setVerifyingKey` is lock-once

**Audit R-M1**: VK can only be set once. To rotate the VK (e.g. ceremony
v2), deploy a new verifier and re-wire `ClaimValidator.setZKVerifier`.
This prevents a hostile owner from silently replacing the trusted-setup
VK with one that accepts arbitrary proofs.

`VerifyingKeySet(bytes32 vkHash)` event includes the hash of all VK fields
for on-chain auditability (AUDIT-018).

## Two verify entrypoints

- **`verifyA(proof, uint256[7] pubs)`** — Path A. Used by current
  ClaimValidator.
- **`verify(proof, publicInputsHash, nullifier, impressionCount)`** —
  Legacy 3-pub adapter. Pads pub3..pub6 with zeros. Proofs generated
  against the alpha-4 circuit *will fail* through this entrypoint
  (intentionally — the circuit constrains 7 inputs). Retained so that
  pre-Path-A callers don't ABI-break during migration.

## Pairing precompile

`_pairing` builds the input bytes and calls precompile `0x08` (BN254
pairing check). The proof is `pi_a, pi_b, pi_c`; pi_a's y-coordinate is
negated to convert the pairing equation. Returns `true` only if the
pairing equation balances.

Both `_acc` (which runs the IC accumulator via the EC-mul and EC-add
precompiles `0x07` and `0x06`) and `_pairing` handle precompile failures
by returning `(0, 0)` / `false` — never reverting.

## VKX edge case

`_verify` checks `if (vkx == 0 && vky == 0) return false`. This rejects
the identity-point case which can happen on precompile failure. There's a
*theoretical* probability that a legitimate verifying key produces VKX
== identity for some inputs, but it's negligible (Schwartz–Zippel-style
collision with the elliptic-curve identity). Documented edge case.

## Why BN254

EVM precompiles `0x06`, `0x07`, and `0x08` are all BN254-only. The
alternative (BLS12-381) doesn't have native precompile support on most
EVMs, so verification would cost ~50× more gas. The trusted-setup
ceremony for BN254 (the Powers of Tau) is also already widely run.

## Trusted setup

Single-party contribution on testnet via `scripts/setup-zk.mjs` (download
ptau, run `groth16 setup`, export VK and zkey). Mainnet will require a
multi-party computation ceremony — the current single-party VK is
*acceptably trusted* for testnet but is the largest cryptographic-trust
surface remaining for mainnet.

## Why "Path A"

Naming: the alpha-3 circuit had 3 public inputs (claimHash, nullifier,
impressions) — the "Path A.0" / pre-stake-gate proof. Alpha-4 extended to
7 — the "Path A" full circuit with stake gate and interest commitment.
A future "Path B" may bind a People-Chain identity into the secret;
that work is deferred and tracked in `project_zk_path_b_people_chain.md`.
