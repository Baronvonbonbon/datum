/**
 * scan-trustbacked-assets.ts
 *
 * Scan trust-backed pallet_assets precompile addresses across a range of
 * candidate IDs to discover live assets (e.g. WUD and unknown IDs).
 *
 * Usage:
 *   npx tsx scripts/scan-trustbacked-assets.ts              # Paseo
 *   RPC_URL=https://... npx tsx scripts/scan-trustbacked-assets.ts
 */
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL ?? "https://eth-rpc-testnet.polkadot.io/";

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
];

function addr(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(8, '0')}000000000000000000000000${SUFFIX}0000`;
}

const SUFFIX = '0120'; // trust-backed

// Candidate IDs to scan
const CANDIDATES: number[] = [
  // Sequential low IDs
  ...Array.from({ length: 50 }, (_, i) => i + 1),
  // Known
  ...[ 8, 17, 23, 30, 690, 1337, 1984, 31337 ],
  // Guesses for WUD and others
  ...[
    50, 51, 52, 53, 54, 55, 60, 65, 69, 70, 80,
    100, 101, 111, 200, 250, 300, 333, 400,
    420, 500, 555, 666, 696, 777, 800, 808,
    888, 900, 999, 1000, 1001, 1111, 1234, 1337,
    1500, 1984, 2000, 2024, 2025, 2112, 3000, 3141,
    4200, 4269, 5000, 6969, 7777, 8888, 9000, 9999,
    10000, 12345, 19840, 20000, 21000, 30000, 31337,
    42069, 50000, 69420, 100000,
    // WUD guesses (could be a round number or meaningful number)
    42, 43, 44, 45, 46, 47, 48, 49,
    314, 404, 808, 1776, 3333, 4444, 5555, 7000,
  ],
];

// Deduplicate
const IDS = [...new Set(CANDIDATES)].sort((a, b) => a - b);

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`Scanning ${IDS.length} candidate trust-backed IDs...\n`);

  const live: { id: number; address: string; supply: string }[] = [];

  // Batch of 8
  for (let i = 0; i < IDS.length; i += 8) {
    const batch = IDS.slice(i, i + 8);
    const results = await Promise.all(batch.map(async (id) => {
      const address = addr(id);
      try {
        const code = await provider.getCode(address);
        if (code === "0x" || code.length <= 2) return null;
        const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
        const supply = await erc20.totalSupply();
        return { id, address, supply: supply.toString() };
      } catch {
        return null;
      }
    }));
    for (const r of results) {
      if (r) {
        console.log(`  LIVE  ID=${r.id.toString().padEnd(8)} addr=${r.address}  supply=${r.supply}`);
        live.push(r);
      }
    }
  }

  console.log(`\nFound ${live.length} live trust-backed assets:`);
  for (const r of live) {
    console.log(`  ID ${r.id}: ${r.address}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
