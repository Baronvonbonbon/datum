// zkWitness.ts — Path A witness builder for tests.
//
// Constructs the private + public inputs for the impression.circom circuit:
//   - Poseidon-based stake Merkle tree (16 levels)
//   - Poseidon-based interest Merkle tree (4 levels)
//   - Nullifier = Poseidon(secret, campaignId, windowId)
//   - userCommitment = Poseidon(secret)
//
// Used by:
//   - End-to-end tests that exercise the real Groth16 verifier (require zkey)
//   - benchmark-paseo.ts and benchmark-testnet.ts for real-proof gas costs
//
// NOTE: this module imports `circomlibjs` lazily so tests that don't need real
// proofs aren't penalized with its load cost.

import { ethers } from "hardhat";

const SCALAR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const STAKE_DEPTH = 16;
const INTEREST_DEPTH = 4;
const INTEREST_LEAVES = 1 << INTEREST_DEPTH; // 16

export interface StakeLeaf {
  userCommitment: bigint;
  balance: bigint;
}

export interface StakeTree {
  root: bigint;
  layers: bigint[][];
}

export interface InterestTree {
  root: bigint;
  layers: bigint[][];
}

export interface ZkWitnessInputs {
  // Public
  claimHash: string;        // already in field
  nullifier: string;
  impressions: string;
  stakeRoot: string;
  minStake: string;
  interestRoot: string;
  requiredCategory: string;
  // Private
  nonce: string;
  secret: string;
  campaignId: string;
  windowId: string;
  balance: string;
  stakePath: string[];
  stakeIdx: string[];
  interestPath: string[];
  interestIdx: string[];
}

export async function loadPoseidon() {
  const { buildPoseidon } = await import("circomlibjs");
  return await buildPoseidon();
}

/** Build a depth-D Merkle tree over `leaves`, padding with `padLeaf`. */
export async function buildMerkle(leaves: bigint[], depth: number, padLeaf: bigint): Promise<{ root: bigint; layers: bigint[][] }> {
  const poseidon = await loadPoseidon();
  const F = poseidon.F;
  const SIZE = 1 << depth;
  const padded = [...leaves];
  while (padded.length < SIZE) padded.push(padLeaf);

  const layers: bigint[][] = [padded];
  for (let d = 0; d < depth; d++) {
    const cur = layers[d];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const h = poseidon([cur[i], cur[i + 1]]);
      next.push(F.toObject(h));
    }
    layers.push(next);
  }
  return { root: layers[depth][0], layers };
}

/** Build the stake tree from raw (commitment, balance) leaves.
 *  Pads to 2^16 with hash(0,0). */
export async function buildStakeTree(leaves: StakeLeaf[]): Promise<StakeTree> {
  const poseidon = await loadPoseidon();
  const F = poseidon.F;
  const leafHashes = leaves.map(l => F.toObject(poseidon([l.userCommitment, l.balance])));
  const ZERO_LEAF = F.toObject(poseidon([0n, 0n]));
  return await buildMerkle(leafHashes, STAKE_DEPTH, ZERO_LEAF);
}

/** Build a 16-leaf interest tree directly from category ids. */
export async function buildInterestTree(categories: bigint[]): Promise<InterestTree> {
  if (categories.length > INTEREST_LEAVES) {
    throw new Error(`interest tree only supports ${INTEREST_LEAVES} categories`);
  }
  // Leaves are categories themselves; pad with 0.
  return await buildMerkle(categories, INTEREST_DEPTH, 0n);
}

/** Extract Merkle path + indices for `leafIndex` in a tree with the given layers. */
export function getPath(layers: bigint[][], leafIndex: number): { path: bigint[]; idx: bigint[] } {
  const path: bigint[] = [];
  const idx: bigint[] = [];
  let i = leafIndex;
  for (let d = 0; d < layers.length - 1; d++) {
    const isRight = (i & 1) === 1;
    const sibling = layers[d][isRight ? i - 1 : i + 1];
    path.push(sibling);
    idx.push(isRight ? 1n : 0n);
    i >>= 1;
  }
  return { path, idx };
}

/** Compute Poseidon(secret) — the userCommitment used in the stake leaf. */
export async function deriveUserCommitment(secret: bigint): Promise<bigint> {
  const poseidon = await loadPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([secret]));
}

/** Compute Poseidon(secret, campaignId, windowId) — the nullifier. */
export async function deriveNullifier(secret: bigint, campaignId: bigint, windowId: bigint): Promise<bigint> {
  const poseidon = await loadPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([secret, campaignId, windowId]));
}

/** Assemble a complete witness object ready to feed into snarkjs.groth16.fullProve. */
export async function buildWitness(args: {
  claimHash: string;           // bytes32 hex — will be reduced mod SCALAR_ORDER
  impressions: bigint;
  nonce: bigint;
  secret: bigint;
  campaignId: bigint;
  windowId: bigint;
  balance: bigint;
  stakeTree: StakeTree;
  stakeLeafIndex: number;
  interestTree: InterestTree;
  interestLeafIndex: number;
  minStake: bigint;
  requiredCategory: bigint;
}): Promise<ZkWitnessInputs> {
  const userCommitment = await deriveUserCommitment(args.secret);
  const nullifier = await deriveNullifier(args.secret, args.campaignId, args.windowId);

  const stakePath = getPath(args.stakeTree.layers, args.stakeLeafIndex);
  const interestPath = getPath(args.interestTree.layers, args.interestLeafIndex);

  const claimHashFe = (BigInt(args.claimHash) % SCALAR_ORDER).toString();

  return {
    claimHash: claimHashFe,
    nullifier: nullifier.toString(),
    impressions: args.impressions.toString(),
    stakeRoot: args.stakeTree.root.toString(),
    minStake: args.minStake.toString(),
    interestRoot: args.interestTree.root.toString(),
    requiredCategory: args.requiredCategory.toString(),
    nonce: args.nonce.toString(),
    secret: args.secret.toString(),
    campaignId: args.campaignId.toString(),
    windowId: args.windowId.toString(),
    balance: args.balance.toString(),
    stakePath: stakePath.path.map(x => x.toString()),
    stakeIdx: stakePath.idx.map(x => x.toString()),
    interestPath: interestPath.path.map(x => x.toString()),
    interestIdx: interestPath.idx.map(x => x.toString()),
  };
}

/** Encode a snarkjs proof object → 256-byte bytes payload accepted by DatumZKVerifier. */
export function encodeProof(proof: any): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
      [proof.pi_c[0], proof.pi_c[1]],
    ]
  );
}
