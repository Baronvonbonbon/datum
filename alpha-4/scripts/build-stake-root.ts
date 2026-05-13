// build-stake-root.ts
//
// Path A off-chain stake-root builder.
//
// Scans DatumZKStake on-chain state and constructs a 16-level Merkle tree
// over leaves `Poseidon(userCommitment, staked)`. Submits the root to
// DatumStakeRoot via `commitStakeRoot(epoch, root)`. Designed to run as one
// of N reporters — threshold of distinct reporter sigs finalizes the root.
//
// Usage:
//   npx hardhat run scripts/build-stake-root.ts --network polkadotTestnet
//
// Required env (in alpha-4/.env):
//   ZK_STAKE_ADDR        — DatumZKStake contract address
//   STAKE_ROOT_ADDR      — DatumStakeRoot contract address
//   REPORTER_KEY         — private key of this reporter (already in addReporter set)
//   EPOCH_BLOCKS         — blocks per epoch (default 600 ~= 1 hour at 6s)
//
// One-shot mode (default): builds tree at current block, submits, exits.
// Daemon mode: pass `--watch` to commit on each epoch boundary.
//
// Limitations:
// - Enumerates users by scanning Deposited events from block 0. For mainnet
//   add a checkpoint cache to avoid full re-scan on each run.
// - Tree depth = 16 (65,536 users max). If outgrown, switch to a deeper tree
//   and regenerate the circuit.

import { ethers } from "hardhat";
import { buildPoseidon } from "circomlibjs";

const STAKE_DEPTH = 16;

interface Leaf {
  user: string;
  commitment: bigint;
  balance: bigint;
}

async function gatherUsers(zkStake: any, fromBlock: number): Promise<Map<string, Leaf>> {
  const out = new Map<string, Leaf>();
  const filter = zkStake.filters.UserCommitmentSet();
  const events = await zkStake.queryFilter(filter, fromBlock, "latest");
  for (const ev of events) {
    const user: string = ev.args.user;
    const commitment: string = ev.args.commitment;
    out.set(user.toLowerCase(), {
      user,
      commitment: BigInt(commitment),
      balance: 0n,
    });
  }
  // Now fill in current staked balance for each
  for (const leaf of out.values()) {
    const bal: bigint = await zkStake.staked(leaf.user);
    leaf.balance = bal;
  }
  return out;
}

/** Build a 16-level Merkle tree over Poseidon(commitment, balance) leaves.
 *  Returns the root and the per-leaf paths (for users to construct witnesses). */
async function buildTree(leaves: Leaf[]): Promise<{ root: bigint; layers: bigint[][] }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Hash leaves
  const leafHashes: bigint[] = leaves.map(l => {
    const h = poseidon([l.commitment, l.balance]);
    return F.toObject(h);
  });

  // Pad to 2^STAKE_DEPTH with hash(0, 0)
  const ZERO_LEAF = F.toObject(poseidon([0n, 0n]));
  const SIZE = 2 ** STAKE_DEPTH;
  while (leafHashes.length < SIZE) leafHashes.push(ZERO_LEAF);

  const layers: bigint[][] = [leafHashes];
  for (let d = 0; d < STAKE_DEPTH; d++) {
    const cur = layers[d];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const h = poseidon([cur[i], cur[i + 1]]);
      next.push(F.toObject(h));
    }
    layers.push(next);
  }
  return { root: layers[STAKE_DEPTH][0], layers };
}

function bigintToBytes32Hex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

async function main() {
  const ZK_STAKE_ADDR = process.env.ZK_STAKE_ADDR;
  const STAKE_ROOT_ADDR = process.env.STAKE_ROOT_ADDR;
  if (!ZK_STAKE_ADDR || !STAKE_ROOT_ADDR) {
    throw new Error("Set ZK_STAKE_ADDR and STAKE_ROOT_ADDR in env");
  }
  const epochBlocks = Number(process.env.EPOCH_BLOCKS ?? 600);

  const zkStake = await ethers.getContractAt("DatumZKStake", ZK_STAKE_ADDR);
  const stakeRoot = await ethers.getContractAt("DatumStakeRoot", STAKE_ROOT_ADDR);

  const provider = ethers.provider;
  const latestBlock = await provider.getBlockNumber();
  const epoch = Math.floor(latestBlock / epochBlocks);

  console.log(`[stake-root] latestBlock=${latestBlock} epoch=${epoch}`);

  const users = await gatherUsers(zkStake, 0);
  console.log(`[stake-root] indexed ${users.size} users with commitments`);

  const leaves = Array.from(users.values());
  const { root } = await buildTree(leaves);
  const rootHex = bigintToBytes32Hex(root);
  console.log(`[stake-root] root = ${rootHex}`);

  // Submit
  const tx = await stakeRoot.commitStakeRoot(BigInt(epoch), rootHex);
  console.log(`[stake-root] commit tx = ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`[stake-root] confirmed in block ${rcpt!.blockNumber}`);

  // Stats
  const totalStaked = leaves.reduce((s, l) => s + l.balance, 0n);
  console.log(`[stake-root] total staked across all users: ${totalStaked} planck-DATUM`);
}

main().catch(e => { console.error(e); process.exit(1); });
