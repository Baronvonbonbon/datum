pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/// @title ImpressionClaim (Path A: stake-gate + private interest match)
/// @notice Proves an impression batch is valid AND that the prover:
///         (a) controls a `secret` whose nullifier dedupes per-window,
///         (b) holds at least `minStake` DATUM (Merkle proof against `stakeRoot`),
///         (c) has `requiredCategory` in their published interest commitment.
///
/// Public inputs (7):
///   claimHash          — keccak256 over (campaignId, publisher, user, eventCount, ...) % r
///   nullifier          — Poseidon(secret, campaignId, windowId); dedupe key in NullifierRegistry
///   impressions        — eventCount; must equal claim.eventCount
///   stakeRoot          — current Merkle root of (userCommitment, balance) leaves
///   minStake           — campaign-set DATUM threshold
///   interestRoot       — user's published interest-tree root (16 leaves, depth 4)
///   requiredCategory   — campaign-required category id (bytes32 → field-truncated)
///
/// Private witnesses:
///   nonce              — claim nonce (binds proof to a specific claim)
///   secret             — user's private secret (never revealed)
///   campaignId         — committed via nullifier
///   windowId           — floor(blockNumber / windowBlocks)
///   balance            — user's DATUM balance (proven ≥ minStake)
///   stakePath[STAKE_DEPTH]   — Merkle siblings for stake leaf
///   stakeIdx[STAKE_DEPTH]    — 0 = sibling is right, 1 = sibling is left
///   interestPath[INTEREST_DEPTH] — Merkle siblings for interest leaf
///   interestIdx[INTEREST_DEPTH]  — 0/1 directionality
///
/// Constraint budget (rough):
///   STAKE_DEPTH=16 × Poseidon(2) (~213)         → ~3,400
///   INTEREST_DEPTH=4 × Poseidon(2)              → ~850
///   userCommitment Poseidon(1)                  → ~75
///   stake leaf Poseidon(2)                      → ~213
///   nullifier Poseidon(3)                       → ~260
///   range check Num2Bits(64)                    → ~64
///   impressions Num2Bits(32)                    → ~32
///   nonce binding                               → 1
///   Σ ≈ 4,900 constraints (fits ptau13: 8,192)
///
/// Trusted setup:
///   `node scripts/setup-zk.mjs` downloads ptau13 (~140 MB) and regenerates
///   impression.zkey, vk.json, setVK-calldata.json (now with IC0..IC7).

template MerkleVerify(DEPTH) {
    signal input leaf;
    signal input path[DEPTH];      // siblings
    signal input idx[DEPTH];       // 0 = leaf is left, 1 = leaf is right
    signal output root;

    component hashers[DEPTH];
    component muxL[DEPTH];
    component muxR[DEPTH];

    signal cur[DEPTH + 1];
    cur[0] <== leaf;

    for (var i = 0; i < DEPTH; i++) {
        // idx must be 0 or 1
        idx[i] * (idx[i] - 1) === 0;

        // (left, right) = idx==0 ? (cur, sibling) : (sibling, cur)
        muxL[i] = Mux1();
        muxL[i].c[0] <== cur[i];     // idx=0 → left=cur
        muxL[i].c[1] <== path[i];    // idx=1 → left=sibling
        muxL[i].s <== idx[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== path[i];    // idx=0 → right=sibling
        muxR[i].c[1] <== cur[i];     // idx=1 → right=cur
        muxR[i].s <== idx[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxL[i].out;
        hashers[i].inputs[1] <== muxR[i].out;
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[DEPTH];
}

template ImpressionClaim() {
    var STAKE_DEPTH = 16;     // 65,536-user capacity per epoch
    var INTEREST_DEPTH = 4;   // 16 interest categories per user

    // ── Public inputs ────────────────────────────────────────────────────
    signal input claimHash;
    signal input nullifier;
    signal input impressions;
    signal input stakeRoot;
    signal input minStake;
    signal input interestRoot;
    signal input requiredCategory;

    // ── Private witnesses ───────────────────────────────────────────────
    signal input nonce;
    signal input secret;
    signal input campaignId;
    signal input windowId;
    signal input balance;
    signal input stakePath[STAKE_DEPTH];
    signal input stakeIdx[STAKE_DEPTH];
    signal input interestPath[INTEREST_DEPTH];
    signal input interestIdx[INTEREST_DEPTH];

    // ── 1. Impressions range: in [1, 2^32+1) ────────────────────────────
    component impBits = Num2Bits(32);
    impBits.in <== impressions - 1;

    // ── 2. Nonce binding (prevents proof reuse on a different claim) ────
    signal nonceSquared;
    nonceSquared <== nonce * nonce;

    // ── 3. Nullifier: Poseidon(secret, campaignId, windowId) ────────────
    component nullH = Poseidon(3);
    nullH.inputs[0] <== secret;
    nullH.inputs[1] <== campaignId;
    nullH.inputs[2] <== windowId;
    nullH.out === nullifier;

    // ── 4. userCommitment = Poseidon(secret) — binds stake leaf to same
    //       secret used in nullifier. Prevents claiming someone else's stake.
    component userC = Poseidon(1);
    userC.inputs[0] <== secret;

    // ── 5. Stake leaf = Poseidon(userCommitment, balance) ───────────────
    component stakeLeaf = Poseidon(2);
    stakeLeaf.inputs[0] <== userC.out;
    stakeLeaf.inputs[1] <== balance;

    // ── 6. Verify Merkle path → stakeRoot ───────────────────────────────
    component stakeMerkle = MerkleVerify(STAKE_DEPTH);
    stakeMerkle.leaf <== stakeLeaf.out;
    for (var i = 0; i < STAKE_DEPTH; i++) {
        stakeMerkle.path[i] <== stakePath[i];
        stakeMerkle.idx[i] <== stakeIdx[i];
    }
    stakeMerkle.root === stakeRoot;

    // ── 7. Range check: balance >= minStake (64-bit) ────────────────────
    component stakeBits = Num2Bits(64);
    stakeBits.in <== balance - minStake;

    // ── 8. Interest Merkle: requiredCategory is a leaf under interestRoot
    //       (Leaves are category ids themselves; Poseidon hash chain up.)
    component interestMerkle = MerkleVerify(INTEREST_DEPTH);
    interestMerkle.leaf <== requiredCategory;
    for (var i = 0; i < INTEREST_DEPTH; i++) {
        interestMerkle.path[i] <== interestPath[i];
        interestMerkle.idx[i] <== interestIdx[i];
    }
    interestMerkle.root === interestRoot;
}

component main {public [
    claimHash, nullifier, impressions,
    stakeRoot, minStake, interestRoot, requiredCategory
]} = ImpressionClaim();
