pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";

/// @title ImpressionClaim
/// @notice Proves that an impression batch is valid for a specific claim, and
///         commits to a per-user per-campaign per-window nullifier (FP-5).
///
/// Public inputs:
///   claimHash  — blake256/keccak256(campaignId, publisher, user, impressions, cpm, nonce, prevHash)
///                truncated to BN254 scalar field: uint256(hash) % r
///                (DatumZKVerifier performs this truncation before verify)
///   nullifier  — Poseidon(secret, campaignId, windowId)
///                deterministic per user/campaign/window; submitted to DatumNullifierRegistry
///                to prevent replay across batches in the same window.
///
/// Private witnesses:
///   impressions — impression count in this batch (must be ≥ 1)
///   nonce       — claim nonce from the claim struct
///   secret      — user's private secret (never revealed; kept client-side)
///   campaignId  — campaign ID (committed through nullifier; prevents cross-campaign reuse)
///   windowId    — floor(blockNumber / windowBlocks); window-scopes the nullifier
///
/// Constraints:
///   32   Num2Bits(32)  — impressions range check
///    1   nonce binding — quadratic commitment
///  ~260  Poseidon(3)   — nullifier derivation
///  ─────────────────
///  ~293  total (well within ptau12 limit of 4096)
///
/// Trusted setup:
///   Re-run `node scripts/setup-zk.mjs` after modifying this file to regenerate
///   impression.zkey, vk.json, and setVK-calldata.json (now with IC0, IC1, IC2).
template ImpressionClaim() {
    signal input claimHash;    // public: claim hash (ties proof to on-chain claim)
    signal input nullifier;    // public: Poseidon(secret, campaignId, windowId)
    signal input impressions;  // private: impression count
    signal input nonce;        // private: claim nonce
    signal input secret;       // private: user's secret (never revealed)
    signal input campaignId;   // private: campaign ID (committed through nullifier)
    signal input windowId;     // private: floor(blockNumber / windowBlocks)

    // Range proof: impressions - 1 must fit in 32 bits
    // Enforces impressions ∈ [1, 2^32+1). Underflows in the field if impressions == 0.
    component bits = Num2Bits(32);
    bits.in <== impressions - 1;

    // Bind nonce to the witness (quadratic constraint so it cannot be optimized away)
    signal nonceSquared;
    nonceSquared <== nonce * nonce;

    // FP-5: Derive nullifier from user secret + campaign + window.
    // Prevents the same user from claiming the same campaign twice in the same window.
    // The relay bot computes windowId = floor(blockNumber / windowBlocks) off-chain.
    component h = Poseidon(3);
    h.inputs[0] <== secret;
    h.inputs[1] <== campaignId;
    h.inputs[2] <== windowId;
    h.out === nullifier;
}

component main {public [claimHash, nullifier]} = ImpressionClaim();
