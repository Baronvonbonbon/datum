// ── Substrate storage key derivation for pallet-revive ──
//
// Storage keys in substrate follow the pattern:
//   twox128(pallet_name) ++ twox128(storage_name) ++ hasher(key1) ++ hasher(key2) ...
//
// For pallet-revive, the pallet name is "Revive" and storage entries include
// things like ContractInfoOf, CodeInfoOf, etc.
//
// However, most pallet-revive state is accessed via runtime API calls
// (ReviveApi_balance, ReviveApi_nonce, ReviveApi_call, etc.) rather than
// raw storage reads. So this module is used mainly for:
//   - System.Account (for balance fallback)
//   - System.Events (for log indexing)

import { bytesToHex } from "./scale.js";
import xxhashInit from "xxhash-wasm";

// Lazy-initialized xxhash instance
let xxhashInstance: Awaited<ReturnType<typeof xxhashInit>> | null = null;

async function getXxhash() {
  if (!xxhashInstance) {
    xxhashInstance = await xxhashInit();
  }
  return xxhashInstance;
}

/** Initialize the xxhash WASM module. Call once at startup for best performance. */
export async function initXxhash(): Promise<void> {
  await getXxhash();
}

function writeLe64(buf: Uint8Array, offset: number, val: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(val & 0xffn);
    val >>= 8n;
  }
}

/**
 * Compute twox128 hash (XXHash 128-bit).
 * This is a non-cryptographic hash used for storage key prefixes.
 * twox128 = xxhash64(seed=0) ++ xxhash64(seed=1)
 */
export function twox128(data: Uint8Array): Uint8Array {
  if (!xxhashInstance) {
    throw new Error("xxhash not initialized — call initXxhash() first");
  }
  const h0 = xxhashInstance.h64Raw(data, 0n);
  const h1 = xxhashInstance.h64Raw(data, 1n);
  const result = new Uint8Array(16);
  writeLe64(result, 0, h0);
  writeLe64(result, 8, h1);
  return result;
}

/**
 * Compute twox64 hash (XXHash 64-bit with seed 0, used for map keys).
 */
export function twox64Concat(data: Uint8Array): Uint8Array {
  if (!xxhashInstance) {
    throw new Error("xxhash not initialized — call initXxhash() first");
  }
  const h = xxhashInstance.h64Raw(data, 0n);
  const result = new Uint8Array(8 + data.length);
  writeLe64(result, 0, h);
  result.set(data, 8);
  return result;
}

/**
 * Blake2-128 concat hasher (used by some pallet maps).
 * Placeholder — requires blake2b import for full impl.
 * For now we'll use the runtime API path which doesn't need this.
 */
export function blake2_128Concat(_data: Uint8Array): Uint8Array {
  throw new Error(
    "blake2_128Concat not yet implemented — use runtime API calls instead of raw storage"
  );
}

/** Build the storage key prefix for a pallet + storage item */
export function storageKeyPrefix(palletName: string, storageName: string): string {
  const palletHash = twox128(new TextEncoder().encode(palletName));
  const storageHash = twox128(new TextEncoder().encode(storageName));
  return "0x" + bytesToHex(palletHash) + bytesToHex(storageHash);
}

/** System.Events storage key (no map key — it's a value, not a map) */
export function systemEventsKey(): string {
  return storageKeyPrefix("System", "Events");
}

/** System.Account storage key for a given AccountId32 */
export function systemAccountKey(accountId: Uint8Array): string {
  const prefix = storageKeyPrefix("System", "Account");
  const keyHash = blake2_128Concat(accountId);
  return prefix + bytesToHex(keyHash);
}
