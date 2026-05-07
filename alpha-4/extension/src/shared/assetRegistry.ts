/**
 * Native Asset Hub token registry for pallet_assets ERC-20 precompiles.
 *
 * Polkadot Hub's pallet-revive exposes pallet_assets as ERC-20-compatible
 * precompile contracts at deterministic H160 addresses. The precompile supports
 * transfer, transferFrom, approve, balanceOf, allowance, totalSupply — but NOT
 * name(), symbol(), or decimals(). This registry provides the missing metadata.
 *
 * Asset types and their precompile suffixes:
 *   trust-backed  (pallet_assets)          → 0x0120
 *   foreign       (pallet_foreign_assets)  → 0x0220
 *   pool          (pallet_pool_assets)     → 0x0320
 *
 * Parachain native tokens arrive on Asset Hub as foreign assets via XCM.
 * Their foreign asset index is assigned on registration — NOT the parachain ID.
 * Indices below are best-effort and should be verified on-chain with
 *   scripts/verify-native-asset.ts
 *
 * EXTENSIBILITY:
 *   - Use registerAssets() to add project-specific or dynamically-discovered tokens.
 *   - The `network` field separates Polkadot and Kusama ecosystems.
 *   - The `category` field drives UI grouping and filtering.
 *   - searchAssets() accepts an optional network filter.
 */

export interface NativeAsset {
  assetId: number;
  symbol: string;
  name: string;
  decimals: number;
  address: string;      // precompile H160
  type: 'trust-backed' | 'pool' | 'foreign';
  network: 'polkadot' | 'kusama';
  category: 'stablecoin' | 'bridged' | 'parachain' | 'community';
  popular?: boolean;    // show in quick-pick row
  parachainId?: number; // source parachain (for reference)
}

const SUFFIXES: Record<NativeAsset['type'], string> = {
  'trust-backed': '0120',
  'pool':         '0320',
  'foreign':      '0220',
};

/**
 * Derive the ERC-20 precompile H160 address for a pallet_assets asset.
 *
 * Format: 0x{assetId_u32_BE_hex_8chars}000000000000000000000000{suffix}0000
 */
export function assetIdToAddress(
  assetId: number,
  type: NativeAsset['type'] = 'trust-backed',
): string {
  const idHex = assetId.toString(16).toUpperCase().padStart(8, '0');
  return `0x${idHex}000000000000000000000000${SUFFIXES[type]}0000`;
}

// Shorthand builders
function tb(assetId: number, symbol: string, name: string, decimals: number, category: NativeAsset['category'] = 'community', popular?: boolean): NativeAsset {
  return { assetId, symbol, name, decimals, type: 'trust-backed', network: 'polkadot', category, address: assetIdToAddress(assetId, 'trust-backed'), popular };
}

function fa(assetId: number, symbol: string, name: string, decimals: number, category: NativeAsset['category'], parachainId: number, popular?: boolean): NativeAsset {
  return { assetId, symbol, name, decimals, type: 'foreign', network: 'polkadot', category, address: assetIdToAddress(assetId, 'foreign'), parachainId, popular };
}

function ktb(assetId: number, symbol: string, name: string, decimals: number, category: NativeAsset['category'] = 'community', popular?: boolean): NativeAsset {
  return { assetId, symbol, name, decimals, type: 'trust-backed', network: 'kusama', category, address: assetIdToAddress(assetId, 'trust-backed'), popular };
}

function kfa(assetId: number, symbol: string, name: string, decimals: number, category: NativeAsset['category'], parachainId: number, popular?: boolean): NativeAsset {
  return { assetId, symbol, name, decimals, type: 'foreign', network: 'kusama', category, address: assetIdToAddress(assetId, 'foreign'), parachainId, popular };
}

/**
 * Well-known Polkadot Asset Hub tokens.
 *
 * NOTE on foreign asset indices: sequential IDs (HDX=1, GLMR=2, …) are the
 * registration order on Polkadot Asset Hub mainnet, NOT parachain IDs.
 * They will return NO_CODE on Paseo (no XCM bridges on testnet).
 * Run scripts/verify-native-asset.ts against mainnet RPC to confirm.
 *
 * NOTE on Kusama foreign assets: KSM and Kusama parachain tokens are bridged
 * to Polkadot Asset Hub via XCM. Their foreign asset indices are best-effort
 * and should be verified on mainnet when Polkadot Hub (pallet-revive) launches.
 */
const _builtinAssets: NativeAsset[] = [
  // ── Stablecoins (trust-backed) ───────────────────────────────────────────
  tb(1984,  'USDt',  'Tether USD',              6,  'stablecoin', true),
  tb(1337,  'USDC',  'USD Coin',                6,  'stablecoin', true),

  // ── Bridged majors (foreign — Snowbridge) ────────────────────────────────
  fa(100,   'WETH',  'Wrapped Ether',           18, 'bridged',  0, true),
  fa(21,    'WBTC',  'Wrapped Bitcoin',          8, 'bridged',  0, true),

  // ── Parachain tokens (foreign) ───────────────────────────────────────────
  fa(1,     'HDX',   'Hydration',               12, 'parachain', 2034, true),
  fa(2,     'GLMR',  'Moonbeam',                18, 'parachain', 2004, true),
  fa(3,     'ASTR',  'Astar',                   18, 'parachain', 2006, true),
  fa(4,     'MYTH',  'Mythos',                  18, 'parachain', 3369),
  fa(5,     'PHA',   'Phala Network',           12, 'parachain', 2035),
  fa(6,     'BNC',   'Bifrost Native Coin',     12, 'parachain', 2030),
  fa(7,     'ACA',   'Acala',                   12, 'parachain', 2000),
  fa(8,     'CFG',   'Centrifuge',              18, 'parachain', 2031),
  fa(9,     'INTR',  'Interlay',                10, 'parachain', 2032),
  fa(10,    'UNQ',   'Unique Network',          18, 'parachain', 2037),
  fa(11,    'NODL',  'Nodle',                   11, 'parachain', 2026),
  fa(12,    'PEN',   'Pendulum',                12, 'parachain', 2094),
  fa(13,    'NEURO', 'NeuroWeb',                12, 'parachain', 2043),
  fa(14,    'EWT',   'Energy Web Token',        18, 'parachain', 3345),

  // ── Polkadot community tokens (trust-backed) ─────────────────────────────
  tb(23,    'PINK',  'Pink Token',              10, 'community'),
  tb(30,    'DED',   'DED',                     10, 'community'),
  tb(17,    'WIFD',  'DOG WIF DOTS',            10, 'community'),
  tb(690,   'BORK',  'BORK',                    10, 'community'),
  tb(31337, 'DOTA',  'DOTA',                     4, 'community'),
  tb(8,     'STINK', 'STINK',                   10, 'community'),
  // WUD — mainnet asset ID best-effort; verify on Polkadot Asset Hub mainnet
  tb(31,    'WUD',   'WUD',                     10, 'community'),

  // ── Kusama native + Kusama parachain tokens (bridged to Polkadot AH) ─────
  // Foreign asset indices on Polkadot Asset Hub are best-effort.
  // These will show NO_CODE on Paseo; verify with mainnet RPC.
  kfa(20,   'KSM',   'Kusama',                  12, 'parachain', 0,    true),
  kfa(22,   'KAR',   'Karura',                  12, 'parachain', 2000),   // Kusama Acala
  kfa(15,   'MOVR',  'Moonriver',               18, 'parachain', 2023),   // Kusama Moonbeam
  kfa(16,   'SDN',   'Shiden',                  18, 'parachain', 2007),   // Kusama Astar
  kfa(17,   'KINT',  'Kintsugi',                12, 'parachain', 2092),   // Kusama Interlay
  kfa(18,   'BSX',   'Basilisk',                12, 'parachain', 2090),   // HydraDX on Kusama
  kfa(19,   'AIR',   'Altair',                  18, 'parachain', 2088),   // Centrifuge on Kusama
];

// ── Mutable registry (supports runtime extension via registerAssets) ─────────
let _assets: NativeAsset[] = [..._builtinAssets];

/**
 * Register additional assets at runtime (e.g., project-specific tokens,
 * dynamically discovered assets, or future Kusama bridge tokens).
 *
 * Duplicate addresses are silently skipped.
 */
export function registerAssets(assets: NativeAsset[]): void {
  const existing = new Set(_assets.map((a) => a.address.toLowerCase()));
  for (const a of assets) {
    if (!existing.has(a.address.toLowerCase())) {
      _assets.push(a);
      existing.add(a.address.toLowerCase());
    }
  }
  _rebuildIndex();
}

// ── Address index (rebuilt on demand) ────────────────────────────────────────
let _addressMap = new Map<string, NativeAsset>(
  _assets.map((a) => [a.address.toLowerCase(), a]),
);

function _rebuildIndex(): void {
  _addressMap = new Map(_assets.map((a) => [a.address.toLowerCase(), a]));
}

// ── Public accessors ──────────────────────────────────────────────────────────

/** The full list of known native assets (including any registered at runtime). */
export function getKnownAssets(network?: NativeAsset['network']): NativeAsset[] {
  return network ? _assets.filter((a) => a.network === network) : _assets;
}

/** Backwards-compatible constant for the initial builtin list. */
export const KNOWN_ASSETS: NativeAsset[] = _builtinAssets;

/** Check whether an address is a known native asset precompile. */
export function isNativeAssetAddress(addr: string): boolean {
  return _addressMap.has(addr.toLowerCase());
}

/** Get metadata for a known native asset, or null if not in the registry. */
export function getAssetMetadata(addr: string): NativeAsset | null {
  return _addressMap.get(addr.toLowerCase()) ?? null;
}

/**
 * Search assets by ticker, name, asset ID, address, or parachain ID.
 *
 * @param query  - search term (empty → returns all)
 * @param network - optional filter: 'polkadot' | 'kusama'
 */
export function searchAssets(query: string, network?: NativeAsset['network']): NativeAsset[] {
  const pool = network ? _assets.filter((a) => a.network === network) : _assets;
  if (!query.trim()) return pool;
  const q = query.trim().toLowerCase();
  // Exact asset ID match
  const asNum = Number(q);
  if (Number.isInteger(asNum) && asNum > 0) {
    const exact = pool.filter((a) =>
      a.assetId === asNum || a.parachainId === asNum || String(a.assetId).includes(q),
    );
    if (exact.length > 0) return exact;
  }
  // Text search: symbol, name, address
  return pool.filter((a) =>
    a.symbol.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q) ||
    a.address.toLowerCase().includes(q)
  );
}

/** Assets to show in quick-pick rows, grouped by network. */
export function popularAssets(network?: NativeAsset['network']): NativeAsset[] {
  return getKnownAssets(network).filter((a) => a.popular);
}
