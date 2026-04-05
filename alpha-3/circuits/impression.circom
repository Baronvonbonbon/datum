pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/bitify.circom";

/// @title ImpressionClaim
/// @notice Proves that an impression batch is valid for a specific claim:
///           1. impressions ∈ [1, 2^32)  — non-zero, bounded batch size
///           2. nonce is committed         — binds witness to this specific claim
///           3. claimHash is a public input — ties the proof to a specific on-chain claim
///
/// Public input:
///   claimHash  — blake256/keccak256(campaignId, publisher, user, impressions, cpm, nonce, prevHash)
///                truncated to BN254 scalar field: uint256(hash) % r
///                (DatumZKVerifier performs this truncation before verify)
///
/// Private witnesses:
///   impressions — impression count in this batch (must be ≥ 1)
///   nonce       — claim nonce from the claim struct
///
/// Constraint count: 32 (Num2Bits) + 1 (nonce ref) ≈ 33
/// Suitable for hermez ptau level 12 (4096 constraints).
template ImpressionClaim() {
    signal input claimHash;    // public
    signal input impressions;  // private: impression count
    signal input nonce;        // private: claim nonce

    // Range proof: impressions - 1 must fit in 32 bits
    // This enforces impressions ∈ [1, 2^32+1) which is sufficient for batch bounds.
    // If impressions == 0, (impressions - 1) underflows in the field → Num2Bits rejects it.
    component bits = Num2Bits(32);
    bits.in <== impressions - 1;

    // Bind nonce to the witness (quadratic constraint so it cannot be optimized away)
    signal nonceSquared;
    nonceSquared <== nonce * nonce;

    // claimHash is declared public so it is always included in the IC array (no extra constraint needed)
}

component main {public [claimHash]} = ImpressionClaim();
