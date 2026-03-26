// CID ↔ bytes32 encoding utilities for IPFS metadata hashes.
//
// CIDv0 ("Qm...") = base58btc(0x12 0x20 + 32-byte SHA-256 digest).
// Strip the 2-byte multihash prefix → 32-byte digest fits exactly in bytes32.

import { decodeBase58, encodeBase58, getBytes, hexlify } from "ethers";

/** Convert a CIDv0 string ("Qm...") to a 0x-prefixed bytes32 hex string. */
export function cidToBytes32(cid: string): string {
  if (!cid.startsWith("Qm")) throw new Error("Only CIDv0 (Qm...) is supported");
  const decoded = decodeBase58(cid);
  const bytes = getBytes(decoded);
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new Error("Invalid CIDv0: expected 34 bytes with 0x1220 prefix");
  }
  return hexlify(bytes.slice(2));
}

/** Convert a 0x-prefixed bytes32 hex string back to a CIDv0 string ("Qm..."). */
export function bytes32ToCid(hex: string): string {
  const digest = getBytes(hex);
  if (digest.length !== 32) throw new Error("Expected 32-byte digest");
  const full = new Uint8Array(34);
  full[0] = 0x12;
  full[1] = 0x20;
  full.set(digest, 2);
  return encodeBase58(full);
}
