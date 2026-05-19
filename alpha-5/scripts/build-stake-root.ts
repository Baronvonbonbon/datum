// build-stake-root.ts
//
// Path A off-chain stake-root builder. Dual-writes to V1 and V2.
//
// Scans DatumZKStake on-chain state and constructs a 16-level Merkle tree
// over leaves `Poseidon(userCommitment, staked)`. Commits the resulting
// root to one or both stake-root oracles depending on WRITE_MODE.
//
// WRITE_MODE (env, default "dual"):
//   v1-only — legacy. Commits only to DatumStakeRoot.
//   dual    — Shadow-mode operations. Commits to BOTH V1 (canonical) and V2
//             (parallel). Divergence between the two is a monitoring signal.
//   v2-only — Post-promotion. Commits only to DatumStakeRootV2.
//
// Usage:
//   npx hardhat run scripts/build-stake-root.ts --network polkadotTestnet
//
// Required env (alpha-4/.env):
//   ZK_STAKE_ADDR        — DatumZKStake contract address
//   STAKE_ROOT_ADDR      — DatumStakeRoot (V1) contract address (required for v1-only/dual)
//   STAKE_ROOT_V2_ADDR   — DatumStakeRootV2 contract address    (required for dual/v2-only)
//   REPORTER_KEY         — private key of this reporter (already addReporter'd on V1
//                          and joinReporters'd on V2 as applicable)
//   EPOCH_BLOCKS         — blocks per epoch (default 600 ~= 1 hour at 6s)
//   WRITE_MODE           — v1-only | dual | v2-only (default: dual)
//
// V2 lifecycle:
//   - If no pending root for this epoch on V2, this reporter calls
//     proposeRoot(epoch, snapshotBlock, root) with proposerBond.
//   - If a pending root already exists with the SAME root, this reporter
//     calls approveRoot(epoch).
//   - If a pending root exists with a DIFFERENT root, we log a divergence
//     warning and abstain. The divergence watcher / fraud-proof path
//     handles it from there.
//   - finalizeRoot is best-effort: any prior epoch whose challenge window
//     has elapsed and meets the approval threshold is finalised opportunistically.

import { ethers } from "hardhat";
import { buildPoseidon } from "circomlibjs";

const STAKE_DEPTH = 16;

// Snapshot offset for V2 proposeRoot. Must satisfy SNAPSHOT_MIN_AGE ≤ offset ≤ SNAPSHOT_MAX_AGE
// (contract constants: MIN=10, MAX=100). 20 sits comfortably in the middle.
const V2_SNAPSHOT_OFFSET = 20;

type WriteMode = "v1-only" | "dual" | "v2-only";

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
  for (const leaf of out.values()) {
    const bal: bigint = await zkStake.staked(leaf.user);
    leaf.balance = bal;
  }
  return out;
}

async function buildTree(leaves: Leaf[]): Promise<{ root: bigint }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const leafHashes: bigint[] = leaves.map(l => {
    const h = poseidon([l.commitment, l.balance]);
    return F.toObject(h);
  });

  const ZERO_LEAF = F.toObject(poseidon([0n, 0n]));
  const SIZE = 2 ** STAKE_DEPTH;
  while (leafHashes.length < SIZE) leafHashes.push(ZERO_LEAF);

  let layer = leafHashes;
  for (let d = 0; d < STAKE_DEPTH; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(F.toObject(poseidon([layer[i], layer[i + 1]])));
    }
    layer = next;
  }
  return { root: layer[0] };
}

function bigintToBytes32Hex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function parseWriteMode(s: string | undefined): WriteMode {
  const v = (s ?? "dual").toLowerCase();
  if (v === "v1-only" || v === "dual" || v === "v2-only") return v;
  throw new Error(`Invalid WRITE_MODE='${s}'. Use v1-only | dual | v2-only.`);
}

// ── V1 submission ─────────────────────────────────────────────────────────────
async function commitV1(addr: string, epoch: bigint, rootHex: string) {
  const v1 = await ethers.getContractAt("DatumStakeRoot", addr);
  console.log(`[v1] commitStakeRoot(${epoch}, ${rootHex})`);
  const tx = await v1.commitStakeRoot(epoch, rootHex);
  const rcpt = await tx.wait();
  console.log(`[v1] confirmed in block ${rcpt!.blockNumber}`);
}

// ── V2 submission (propose / approve / abstain on divergence) ─────────────────
async function commitV2(addr: string, epoch: bigint, rootHex: string, snapshotBlock: number) {
  const v2 = await ethers.getContractAt("DatumStakeRootV2", addr);
  const [reporter] = await ethers.getSigners();

  // 1. Has this epoch already been finalised?
  const finalised: string = await v2.rootAt(epoch);
  if (finalised !== ethers.ZeroHash) {
    if (finalised.toLowerCase() === rootHex.toLowerCase()) {
      console.log(`[v2] epoch ${epoch} already finalised with matching root — nothing to do`);
    } else {
      console.warn(`[v2] WARNING: epoch ${epoch} finalised with DIFFERENT root`);
      console.warn(`     finalised: ${finalised}`);
      console.warn(`     ours:      ${rootHex}`);
    }
    return;
  }

  // 2. Inspect pending state via the auto-generated public getter on the
  //    private mapping. We can't read `_pending` directly; instead detect
  //    pending state via the RootProposed event for this epoch.
  const proposedEvents = await v2.queryFilter(v2.filters.RootProposed(epoch));
  const pendingEvent = proposedEvents.length > 0 ? proposedEvents[proposedEvents.length - 1] : undefined;
  const proposerBond: bigint = await v2.proposerBond();

  if (!pendingEvent) {
    // First reporter for this epoch — propose.
    console.log(`[v2] proposeRoot(epoch=${epoch}, snapshot=${snapshotBlock}, root=${rootHex})`);
    const tx = await v2.proposeRoot(epoch, snapshotBlock, rootHex, { value: proposerBond });
    const rcpt = await tx.wait();
    console.log(`[v2] proposeRoot confirmed in block ${rcpt!.blockNumber}`);
    return;
  }

  const pendingRoot = (pendingEvent as any).args.root as string;
  if (pendingRoot.toLowerCase() !== rootHex.toLowerCase()) {
    console.warn(`[v2] DIVERGENCE: pending root for epoch ${epoch} differs from ours`);
    console.warn(`     pending: ${pendingRoot}`);
    console.warn(`     ours:    ${rootHex}`);
    console.warn(`     ABSTAINING — investigate before approving.`);
    return;
  }

  // Same root pending — co-sign.
  const approvedEvents = await v2.queryFilter(v2.filters.RootApproved(epoch, reporter.address));
  if (approvedEvents.length > 0) {
    console.log(`[v2] already approved epoch ${epoch} from this reporter`);
    return;
  }

  console.log(`[v2] approveRoot(epoch=${epoch})`);
  const tx = await v2.approveRoot(epoch);
  const rcpt = await tx.wait();
  console.log(`[v2] approveRoot confirmed in block ${rcpt!.blockNumber}`);
}

// Opportunistically finalise any earlier pending epoch whose challenge window
// has lapsed. Best-effort: failures are logged and swallowed.
async function tryFinaliseEarlier(addr: string, currentEpoch: bigint) {
  const v2 = await ethers.getContractAt("DatumStakeRootV2", addr);
  const latestFinal: bigint = await v2.latestEpoch();
  for (let e = latestFinal + 1n; e < currentEpoch; e++) {
    try {
      const tx = await v2.finalizeRoot(e);
      await tx.wait();
      console.log(`[v2] finalizeRoot(${e}) ok`);
    } catch (err: any) {
      // E96 = challenge window not elapsed; E46 = below approval threshold;
      // E01 = no pending. All expected to be transient.
      console.log(`[v2] finalizeRoot(${e}) skipped: ${err?.shortMessage ?? err?.message ?? err}`);
    }
  }
}

async function main() {
  const WRITE_MODE: WriteMode = parseWriteMode(process.env.WRITE_MODE);
  const ZK_STAKE_ADDR = process.env.ZK_STAKE_ADDR;
  const STAKE_ROOT_ADDR = process.env.STAKE_ROOT_ADDR;
  const STAKE_ROOT_V2_ADDR = process.env.STAKE_ROOT_V2_ADDR;

  if (!ZK_STAKE_ADDR) throw new Error("Set ZK_STAKE_ADDR in env");
  if (WRITE_MODE !== "v2-only" && !STAKE_ROOT_ADDR) {
    throw new Error(`WRITE_MODE=${WRITE_MODE} requires STAKE_ROOT_ADDR`);
  }
  if (WRITE_MODE !== "v1-only" && !STAKE_ROOT_V2_ADDR) {
    throw new Error(`WRITE_MODE=${WRITE_MODE} requires STAKE_ROOT_V2_ADDR`);
  }

  const epochBlocks = Number(process.env.EPOCH_BLOCKS ?? 600);
  const zkStake = await ethers.getContractAt("DatumZKStake", ZK_STAKE_ADDR);

  const provider = ethers.provider;
  const latestBlock = await provider.getBlockNumber();
  const epoch = BigInt(Math.floor(latestBlock / epochBlocks));
  const snapshotBlock = latestBlock - V2_SNAPSHOT_OFFSET;

  console.log(`[stake-root] WRITE_MODE=${WRITE_MODE} latestBlock=${latestBlock} epoch=${epoch} snapshotBlock=${snapshotBlock}`);

  const users = await gatherUsers(zkStake, 0);
  console.log(`[stake-root] indexed ${users.size} users with commitments`);

  const leaves = Array.from(users.values());
  const { root } = await buildTree(leaves);
  const rootHex = bigintToBytes32Hex(root);
  console.log(`[stake-root] root = ${rootHex}`);

  if (WRITE_MODE === "v1-only" || WRITE_MODE === "dual") {
    await commitV1(STAKE_ROOT_ADDR!, epoch, rootHex);
  }
  if (WRITE_MODE === "dual" || WRITE_MODE === "v2-only") {
    await commitV2(STAKE_ROOT_V2_ADDR!, epoch, rootHex, snapshotBlock);
    await tryFinaliseEarlier(STAKE_ROOT_V2_ADDR!, epoch);
  }

  const totalStaked = leaves.reduce((s, l) => s + l.balance, 0n);
  console.log(`[stake-root] total staked across all users: ${totalStaked} planck-DATUM`);
}

main().catch(e => { console.error(e); process.exit(1); });
