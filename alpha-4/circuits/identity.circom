pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

/// @title Identity (ZK ownership of a commitment)
/// @notice Proves the prover knows `secret` such that
///         `Poseidon(secret) == commitment`. Used by
///         DatumStakeRootV2.challengeRootBalance — a user proves
///         on-chain that a leaf in the proposed root belongs to them,
///         enabling them to challenge a balance discrepancy without
///         revealing their secret.
///
/// Public inputs (1):
///   commitment — Poseidon(secret), the user's on-chain identity hash
///
/// Private witnesses:
///   secret    — never revealed; only the prover knows it
///
/// Two constraints:
///   - one Poseidon hash (~213 R1CS constraints)
///   - one equality check
///
/// Circuit size is tiny — proof generation runs in seconds with a small
/// proving key (~few hundred KB). Trusted setup uses ptau12 (4096
/// constraints) which is plenty of headroom and matches the existing
/// project tooling.
template Identity() {
    signal input commitment;   // public
    signal input secret;       // private

    component h = Poseidon(1);
    h.inputs[0] <== secret;

    // Bind: Poseidon(secret) must equal the asserted commitment.
    commitment === h.out;
}

component main { public [commitment] } = Identity();
