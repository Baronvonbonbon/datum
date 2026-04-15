// ── Extrinsic builder for Revive.eth_transact ──
//
// pallet-revive accepts raw Ethereum-signed transactions via the
// `Revive.eth_transact` call. This is submitted as an unsigned extrinsic
// because the Ethereum signature inside the raw tx IS the authorization.
//
// Extrinsic format (V4 unsigned):
//   compact(length) | 0x04 | pallet_index | call_index | SCALE(Vec<u8> payload)
//
// The pallet index and call index depend on the runtime. For Asset Hub:
//   Revive pallet index: discovered from runtime metadata or hardcoded
//   eth_transact call index: typically 0 (first call in the pallet)
//
// Since we don't have runtime metadata parsing yet, we use configurable
// pallet/call indices with sensible defaults for Asset Hub.

import { encodeCompact, encodeBytes, concatBytes } from "./scale.js";

/** Default Revive pallet index on Asset Hub (may vary per runtime version) */
const DEFAULT_REVIVE_PALLET_INDEX = 65;
/** Default eth_transact call index within the Revive pallet */
const DEFAULT_ETH_TRANSACT_CALL_INDEX = 3;

export interface ExtrinsicConfig {
  revivePalletIndex?: number;
  ethTransactCallIndex?: number;
}

/**
 * Build an unsigned extrinsic that wraps a raw Ethereum transaction
 * in a Revive.eth_transact call.
 *
 * @param rawTx - The signed Ethereum transaction bytes (hex string with 0x prefix)
 * @param config - Optional pallet/call index overrides
 * @returns hex string (with 0x prefix) of the complete unsigned extrinsic
 */
export function buildEthTransactExtrinsic(
  rawTx: string,
  config?: ExtrinsicConfig,
): string {
  const palletIndex = config?.revivePalletIndex ?? DEFAULT_REVIVE_PALLET_INDEX;
  const callIndex = config?.ethTransactCallIndex ?? DEFAULT_ETH_TRANSACT_CALL_INDEX;

  // Strip 0x prefix and convert to bytes
  const txHex = rawTx.startsWith("0x") ? rawTx.slice(2) : rawTx;
  const txBytes = new Uint8Array(txHex.length / 2);
  for (let i = 0; i < txBytes.length; i++) {
    txBytes[i] = parseInt(txHex.substring(i * 2, i * 2 + 2), 16);
  }

  // Build call data: pallet_index | call_index | SCALE(Vec<u8> rawTx)
  const callData = concatBytes(
    new Uint8Array([palletIndex, callIndex]),
    encodeBytes(txBytes),
  );

  // Build unsigned extrinsic: 0x04 (V4, no signature) | call_data
  const extrinsicPayload = concatBytes(
    new Uint8Array([0x04]), // extrinsic version 4, bit 7=0 (unsigned)
    callData,
  );

  // Length-prefix the whole thing
  const lengthPrefix = encodeCompact(extrinsicPayload.length);
  const fullExtrinsic = concatBytes(lengthPrefix, extrinsicPayload);

  // Convert to hex
  let hex = "0x";
  for (const byte of fullExtrinsic) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
