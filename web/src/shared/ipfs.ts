// CID ↔ bytes32 encoding utilities for IPFS metadata hashes.
//
// CIDv0 ("Qm...") = base58btc(0x12 0x20 + 32-byte SHA-256 digest).
// We strip the 2-byte multihash prefix to fit the 32-byte digest into a Solidity bytes32.
// Reversible: prepend 0x1220, base58-encode to recover the original CID.

import { decodeBase58, encodeBase58, getBytes, hexlify, zeroPadValue } from "ethers";

/**
 * Convert a CIDv0 string ("Qm...") to a 0x-prefixed bytes32 hex string.
 * Strips the 0x1220 multihash prefix, leaving the raw 32-byte SHA-256 digest.
 */
export function cidToBytes32(cid: string): string {
  if (!cid.startsWith("Qm")) throw new Error("Only CIDv0 (Qm...) is supported");
  const decoded = decodeBase58(cid); // ethers v6: returns bigint
  // Convert bigint to 34-byte Uint8Array (CIDv0 = 0x1220 prefix + 32-byte digest)
  const hex = decoded.toString(16).padStart(68, "0"); // 34 bytes = 68 hex chars
  const bytes = getBytes("0x" + hex);
  // CIDv0 = 0x12 (sha2-256) + 0x20 (32 bytes length) + 32-byte digest = 34 bytes
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new Error("Invalid CIDv0: expected 34 bytes with 0x1220 prefix");
  }
  // Return the 32-byte digest as hex
  return hexlify(bytes.slice(2));
}

/**
 * Convert a 0x-prefixed bytes32 hex string back to a CIDv0 string ("Qm...").
 * Prepends the 0x1220 multihash prefix and base58-encodes.
 */
export function bytes32ToCid(hex: string): string {
  const digest = getBytes(hex);
  if (digest.length !== 32) throw new Error("Expected 32-byte digest");
  // Prepend multihash prefix: 0x12 (sha2-256) + 0x20 (32 bytes)
  const full = new Uint8Array(34);
  full[0] = 0x12;
  full[1] = 0x20;
  full.set(digest, 2);
  return encodeBase58(full);
}

/**
 * Convert a bytes32 metadata hash to a full IPFS gateway URL.
 * Returns null if the hash is zero (no metadata set).
 */
export function metadataUrl(hex: string, gateway: string): string | null {
  if (!hex || hex === "0x" + "0".repeat(64)) return null;
  // Validate gateway is a proper HTTPS URL (or localhost for dev)
  try {
    const parsed = new URL(gateway);
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!isLocal && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const cid = bytes32ToCid(hex);
  // Ensure gateway ends with /
  const gw = gateway.endsWith("/") ? gateway : gateway + "/";
  return gw + cid;
}
