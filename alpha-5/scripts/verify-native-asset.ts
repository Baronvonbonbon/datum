/**
 * verify-native-asset.ts
 *
 * Batch-verify which pallet_assets ERC-20 precompiles are live on the target
 * chain. Tests totalSupply() on every KNOWN_ASSETS entry.
 *
 * Usage:
 *   npx tsx scripts/verify-native-asset.ts                    # Paseo (default)
 *   RPC_URL=https://... npx tsx scripts/verify-native-asset.ts  # custom RPC
 */
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL ?? process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

// Inline registry so the script is self-contained
const SUFFIXES: Record<string, string> = { 'trust-backed': '0120', 'pool': '0320', 'foreign': '0220' };
function addr(id: number, type: string = 'trust-backed'): string {
  return `0x${id.toString(16).toUpperCase().padStart(8, '0')}000000000000000000000000${SUFFIXES[type]}0000`;
}

interface Asset { symbol: string; assetId: number; type: string; name: string; network: string; }

const ASSETS: Asset[] = [
  // ── Polkadot: Stablecoins (trust-backed) ──────────────────────────────────
  { symbol: 'USDt',  assetId: 1984,  type: 'trust-backed', name: 'Tether USD',         network: 'polkadot' },
  { symbol: 'USDC',  assetId: 1337,  type: 'trust-backed', name: 'USD Coin',            network: 'polkadot' },
  // ── Polkadot: Bridged (foreign — Snowbridge) ───────────────────────────────
  { symbol: 'WETH',  assetId: 100,   type: 'foreign',      name: 'Wrapped Ether',       network: 'polkadot' },
  { symbol: 'WBTC',  assetId: 21,    type: 'foreign',      name: 'Wrapped Bitcoin',     network: 'polkadot' },
  // ── Polkadot: Parachain tokens (foreign) ──────────────────────────────────
  { symbol: 'HDX',   assetId: 1,     type: 'foreign',      name: 'Hydration',           network: 'polkadot' },
  { symbol: 'GLMR',  assetId: 2,     type: 'foreign',      name: 'Moonbeam',            network: 'polkadot' },
  { symbol: 'ASTR',  assetId: 3,     type: 'foreign',      name: 'Astar',               network: 'polkadot' },
  { symbol: 'MYTH',  assetId: 4,     type: 'foreign',      name: 'Mythos',              network: 'polkadot' },
  { symbol: 'PHA',   assetId: 5,     type: 'foreign',      name: 'Phala Network',       network: 'polkadot' },
  { symbol: 'BNC',   assetId: 6,     type: 'foreign',      name: 'Bifrost',             network: 'polkadot' },
  { symbol: 'ACA',   assetId: 7,     type: 'foreign',      name: 'Acala',               network: 'polkadot' },
  { symbol: 'CFG',   assetId: 8,     type: 'foreign',      name: 'Centrifuge',          network: 'polkadot' },
  { symbol: 'INTR',  assetId: 9,     type: 'foreign',      name: 'Interlay',            network: 'polkadot' },
  { symbol: 'UNQ',   assetId: 10,    type: 'foreign',      name: 'Unique Network',      network: 'polkadot' },
  { symbol: 'NODL',  assetId: 11,    type: 'foreign',      name: 'Nodle',               network: 'polkadot' },
  { symbol: 'PEN',   assetId: 12,    type: 'foreign',      name: 'Pendulum',            network: 'polkadot' },
  { symbol: 'NEURO', assetId: 13,    type: 'foreign',      name: 'NeuroWeb',            network: 'polkadot' },
  { symbol: 'EWT',   assetId: 14,    type: 'foreign',      name: 'Energy Web Token',    network: 'polkadot' },
  // ── Polkadot: Community (trust-backed) ────────────────────────────────────
  { symbol: 'PINK',  assetId: 23,    type: 'trust-backed', name: 'Pink Token',          network: 'polkadot' },
  { symbol: 'DED',   assetId: 30,    type: 'trust-backed', name: 'DED',                 network: 'polkadot' },
  { symbol: 'WIFD',  assetId: 17,    type: 'trust-backed', name: 'DOG WIF DOTS',        network: 'polkadot' },
  { symbol: 'BORK',  assetId: 690,   type: 'trust-backed', name: 'BORK',                network: 'polkadot' },
  { symbol: 'DOTA',  assetId: 31337, type: 'trust-backed', name: 'DOTA',                network: 'polkadot' },
  { symbol: 'STINK', assetId: 8,     type: 'trust-backed', name: 'STINK',               network: 'polkadot' },
  { symbol: 'WUD',   assetId: 31,    type: 'trust-backed', name: 'WUD',                 network: 'polkadot' },
  // ── Kusama: native + parachain tokens (foreign on Polkadot AH) ───────────
  // NOTE: foreign indices are best-effort — run against mainnet RPC to confirm
  { symbol: 'KSM',   assetId: 20,    type: 'foreign',      name: 'Kusama',              network: 'kusama'   },
  { symbol: 'KAR',   assetId: 22,    type: 'foreign',      name: 'Karura',              network: 'kusama'   },
  { symbol: 'MOVR',  assetId: 15,    type: 'foreign',      name: 'Moonriver',           network: 'kusama'   },
  { symbol: 'SDN',   assetId: 16,    type: 'foreign',      name: 'Shiden',              network: 'kusama'   },
  { symbol: 'KINT',  assetId: 17,    type: 'foreign',      name: 'Kintsugi',            network: 'kusama'   },
  { symbol: 'BSX',   assetId: 18,    type: 'foreign',      name: 'Basilisk',            network: 'kusama'   },
  { symbol: 'AIR',   assetId: 19,    type: 'foreign',      name: 'Altair',              network: 'kusama'   },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Chain ID: ${network.chainId}\n`);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const results: { symbol: string; address: string; type: string; network: string; hasCode: boolean; supply: string; status: string }[] = [];

  // Check in batches of 5 to avoid RPC flood
  for (let i = 0; i < ASSETS.length; i += 5) {
    const batch = ASSETS.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async (asset) => {
      const precompile = addr(asset.assetId, asset.type);
      let hasCode = false;
      let supply = "—";
      let status = "FAIL";
      try {
        const code = await provider.getCode(precompile);
        hasCode = code !== "0x" && code.length > 2;
      } catch { /* */ }
      if (hasCode) {
        try {
          const erc20 = new ethers.Contract(precompile, ERC20_ABI, provider);
          const s = await erc20.totalSupply();
          supply = s.toString();
          status = "OK";
        } catch (err: any) {
          status = `CODE_BUT_CALL_FAILED`;
        }
      } else {
        status = "NO_CODE";
      }
      return { symbol: asset.symbol, address: precompile, type: asset.type, network: asset.network, hasCode, supply, status };
    }));
    results.push(...batchResults);
  }

  // Print table
  console.log("Symbol".padEnd(8) + "Net".padEnd(8) + "Type".padEnd(15) + "Status".padEnd(22) + "TotalSupply".padEnd(24) + "Address");
  console.log("─".repeat(118));
  for (const r of results) {
    const tag = r.status === "OK" ? "✓" : "✗";
    console.log(
      `${tag} ${r.symbol.padEnd(7)}${r.network.padEnd(8)}${r.type.padEnd(15)}${r.status.padEnd(22)}${r.supply.padEnd(24)}${r.address}`
    );
  }

  const ok = results.filter((r) => r.status === "OK").length;
  console.log(`\n${ok}/${results.length} precompiles live.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
