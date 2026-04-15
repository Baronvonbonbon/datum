// ── Chain spec resolver ──
//
// Resolves named chain presets to relay + parachain spec JSON strings.
// Specs are loaded dynamically to avoid bundling multi-MB JSON in the package.
//
// For production use, specs can be:
//   1. Bundled as static JSON files alongside the package
//   2. Fetched at runtime from a well-known URL
//   3. Provided directly via PineConfig for "custom" chains
//
// smoldot embeds well-known chain specs — we use @polkadot-api/smoldot which
// re-exports them as importable modules.

import type { ChainPreset } from "../types.js";

interface ChainSpecs {
  relayChainSpec: string;
  parachainChainSpec: string;
}

// Mapping from preset names to @polkadot-api/known-chains identifiers
const SPEC_MAP: Record<ChainPreset, { relay: string; para: string }> = {
  "paseo-asset-hub": { relay: "paseo", para: "paseo_asset_hub" },
  "polkadot-asset-hub": { relay: "polkadot", para: "polkadot_asset_hub" },
  "kusama-asset-hub": { relay: "kusama", para: "ksmcc3_asset_hub" },
  "westend-asset-hub": { relay: "westend2", para: "westend2_asset_hub" },
};

/**
 * Resolve a chain preset to relay and parachain spec JSON strings.
 *
 * Uses @polkadot-api/known-chains which provides well-known chain specs
 * as importable modules. These are the same specs smoldot uses internally.
 */
export async function resolveChainSpec(preset: ChainPreset): Promise<ChainSpecs> {
  const mapping = SPEC_MAP[preset];
  if (!mapping) {
    throw new Error(
      `Unknown chain preset: ${preset}. Valid presets: ${Object.keys(SPEC_MAP).join(", ")}`,
    );
  }

  // @polkadot-api/known-chains exports chain specs as named string exports
  try {
    const knownChains = await import("@polkadot-api/known-chains") as unknown as Record<string, string>;
    const relaySpec = knownChains[mapping.relay];
    const paraSpec = knownChains[mapping.para];

    if (!relaySpec || !paraSpec) {
      throw new Error(
        `Chain specs not found in @polkadot-api/known-chains for ${preset}. ` +
          `Expected exports: ${mapping.relay}, ${mapping.para}`,
      );
    }

    return {
      relayChainSpec: relaySpec,
      parachainChainSpec: paraSpec,
    };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("Cannot find module") ||
        e.message.includes("ERR_MODULE_NOT_FOUND"))
    ) {
      throw new Error(
        `@polkadot-api/known-chains is not installed. Install it to use named chain presets, ` +
          `or provide chain specs directly via PineConfig with chain="custom".\n` +
          `  npm install @polkadot-api/known-chains`,
      );
    }
    throw e;
  }
}
