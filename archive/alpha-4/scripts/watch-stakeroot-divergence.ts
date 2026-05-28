// watch-stakeroot-divergence.ts
//
// Compare DatumStakeRoot (V1) and DatumStakeRootV2 finalised roots over the
// recent epoch window. While V2 is in SHADOW mode V1 is canonical, but any
// divergence is one of:
//   1. V2 reporters committed a bad root (V1 is right)
//   2. V1 reporters committed a bad root (V2 is right)
//   3. Dual-write infrastructure bug (leaf hash / snapshot drift)
//
// Usage:
//   STAKE_ROOT_ADDR=0x... STAKE_ROOT_V2_ADDR=0x... \
//     npx hardhat run scripts/watch-stakeroot-divergence.ts --network polkadotTestnet
//
//   Add --watch to poll every POLL_SECONDS (default 60).
//
// Exit codes:
//   0 — all recent epochs agree (or V2 hasn't finalised one yet)
//   1 — divergence detected on a finalised epoch (alert-worthy)
//   2 — config / RPC error

import { ethers } from "hardhat";

const LOOKBACK_EPOCHS = 8;
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 60);

interface EpochCompare {
  epoch: bigint;
  v1: string;
  v2: string;
  status: "agree" | "v2-missing" | "v1-missing" | "diverge" | "both-missing";
}

export async function compareOnce(v1Addr: string, v2Addr: string): Promise<{ rows: EpochCompare[]; diverged: boolean }> {
  const v1 = await ethers.getContractAt("DatumStakeRoot", v1Addr);
  const v2 = await ethers.getContractAt("DatumStakeRootV2", v2Addr);

  const v1Latest: bigint = await v1.latestEpoch();
  const v2Latest: bigint = await v2.latestEpoch();
  const maxEpoch = v1Latest > v2Latest ? v1Latest : v2Latest;
  const start = maxEpoch >= BigInt(LOOKBACK_EPOCHS) ? maxEpoch - BigInt(LOOKBACK_EPOCHS) + 1n : 0n;

  const rows: EpochCompare[] = [];
  let diverged = false;

  for (let e = start; e <= maxEpoch; e++) {
    const [r1, r2]: [string, string] = await Promise.all([v1.rootAt(e), v2.rootAt(e)]);
    const r1Set = r1 !== ethers.ZeroHash;
    const r2Set = r2 !== ethers.ZeroHash;
    let status: EpochCompare["status"];
    if (!r1Set && !r2Set) status = "both-missing";
    else if (r1Set && !r2Set) status = "v2-missing";
    else if (!r1Set && r2Set) status = "v1-missing";
    else if (r1.toLowerCase() === r2.toLowerCase()) status = "agree";
    else { status = "diverge"; diverged = true; }
    rows.push({ epoch: e, v1: r1, v2: r2, status });
  }
  return { rows, diverged };
}

export function printRows(rows: EpochCompare[]) {
  console.log(`  epoch | status       | v1 root                                                            | v2 root`);
  console.log(`  ------+--------------+--------------------------------------------------------------------+--------------------------------------------------------------------`);
  for (const r of rows) {
    const short = (s: string) => s === ethers.ZeroHash ? "(none)".padEnd(66) : s;
    console.log(`  ${String(r.epoch).padStart(5)} | ${r.status.padEnd(12)} | ${short(r.v1)} | ${short(r.v2)}`);
  }
}

async function main() {
  const V1 = process.env.STAKE_ROOT_ADDR;
  const V2 = process.env.STAKE_ROOT_V2_ADDR;
  if (!V1 || !V2) {
    console.error("Set STAKE_ROOT_ADDR and STAKE_ROOT_V2_ADDR in env");
    process.exit(2);
  }
  const watch = process.argv.includes("--watch");

  do {
    const ts = new Date().toISOString();
    try {
      const { rows, diverged } = await compareOnce(V1, V2);
      console.log(`\n[watch] ${ts}`);
      printRows(rows);
      if (diverged) {
        console.error(`[watch] DIVERGENCE DETECTED — V1 and V2 disagree on a finalised epoch.`);
        if (!watch) process.exit(1);
      } else {
        console.log(`[watch] OK — no divergence in lookback window.`);
      }
    } catch (err: any) {
      console.error(`[watch] ${ts} RPC error: ${err?.shortMessage ?? err?.message ?? err}`);
      if (!watch) process.exit(2);
    }
    if (watch) await new Promise(r => setTimeout(r, POLL_SECONDS * 1000));
  } while (watch);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(2); });
}
