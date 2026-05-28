// Polkadot Bulletin Chain helpers — CID encoding + gateway URLs (Phase A, F1).
//
// Bulletin Chain stores arbitrary data and returns an IPFS-compatible CID.
// Default config = Blake2b-256 multihash + Raw codec; chunked uploads use the
// DAG-PB codec for the manifest. Our on-chain BulletinRef stores just the
// 32-byte multihash digest + a 1-byte codec discriminator (0 = raw, 1 = dag-pb).
// This file reconstructs the full CIDv1 from those two fields and builds the
// Paseo IPFS gateway URL.
//
// CIDv1 structure:
//   [0x01 cidv1] | [codec varint] | [multihash code varint] | [digest length] | [digest]
//
// Multicodec values used:
//   raw    = 0x55 (single-byte varint)
//   dag-pb = 0x70 (single-byte varint)
// Multihash:
//   blake2b-256 = 0xb220, encoded as 3-byte varint 0xa0 0xe4 0x02
//   digest length = 0x20 (32, single-byte varint)
//
// Base encoding: base32 lowercase no-padding (RFC 4648) prefixed with 'b' for
// the multibase tag. Result looks like `bafk2bzace...`.
//
// Pure functions only; no PAPI / network deps. PAPI store/renew wrappers live
// in F2 (separate commit).

// ── Codec discriminator (matches DatumCampaigns.BulletinRef.cidCodec) ─────────

/** Codec values matching the on-chain `cidCodec` field on `BulletinRef`. */
export enum BulletinCodec {
  Raw    = 0, // single file ≤ 8 MiB
  DagPb  = 1, // chunked-manifest root (UnixFS) for files up to ~64 MiB
}

/** Multicodec varint value for each supported Bulletin codec. */
const MULTICODEC: Record<BulletinCodec, number> = {
  [BulletinCodec.Raw]: 0x55,
  [BulletinCodec.DagPb]: 0x70,
};

/** Blake2b-256 multihash code, encoded as 3-byte varint (0xb220 → 0xa0 0xe4 0x02). */
const BLAKE2B_256_VARINT = new Uint8Array([0xa0, 0xe4, 0x02]);
const BLAKE2B_256_DIGEST_LEN = 0x20; // 32 bytes

// ── Paseo network endpoints ───────────────────────────────────────────────────

/** Public IPFS gateway serving Bulletin Chain content on Paseo. */
export const PASEO_BULLETIN_GATEWAY = "https://paseo-ipfs.polkadot.io/ipfs/";

/** Bulletin Chain RPC endpoint for Paseo. Used by F2 PAPI wrappers. */
export const PASEO_BULLETIN_RPC = "wss://paseo-bulletin-rpc.polkadot.io";

/** Hub-side block lead time before the contract emits BulletinRenewalDue. */
export const BULLETIN_RENEWAL_LEAD_BLOCKS = 14_400n;

/** Hub-side cap on per-renewal expiry advancement (~15.3 days @ 6s blocks). */
export const MAX_RETENTION_ADVANCE_BLOCKS = 220_000n;

// ── Base32 lowercase no-padding (RFC 4648) ────────────────────────────────────

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < input.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(input[i]);
    if (idx < 0) throw new Error(`Invalid base32 character at position ${i}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ── CID encode / decode ───────────────────────────────────────────────────────

/**
 * Reconstruct an IPFS-compatible CIDv1 from a 32-byte Blake2b-256 digest plus
 * a Bulletin codec discriminator. Mirrors what the Bulletin Chain produces.
 *
 * @param digestHex  0x-prefixed 32-byte hex (the on-chain `cidDigest` field)
 * @param codec      BulletinCodec.Raw (0) or BulletinCodec.DagPb (1)
 * @returns          CIDv1 string like `bafk2bzace...`
 */
export function bulletinCidFromDigest(digestHex: string, codec: BulletinCodec): string {
  if (codec !== BulletinCodec.Raw && codec !== BulletinCodec.DagPb) {
    throw new Error(`Unsupported Bulletin codec: ${codec}`);
  }
  const digest = hexToBytes(digestHex);
  if (digest.length !== 32) {
    throw new Error(`Expected 32-byte digest, got ${digest.length}`);
  }
  // CIDv1 byte layout:
  //   0x01 (cidv1) | codec (1 byte varint) | 0xa0 0xe4 0x02 (blake2b-256 mh code) |
  //   0x20 (digest length) | 32-byte digest
  const cidBytes = new Uint8Array(1 + 1 + 3 + 1 + 32);
  let i = 0;
  cidBytes[i++] = 0x01; // CIDv1
  cidBytes[i++] = MULTICODEC[codec];
  cidBytes.set(BLAKE2B_256_VARINT, i); i += 3;
  cidBytes[i++] = BLAKE2B_256_DIGEST_LEN;
  cidBytes.set(digest, i);
  // Multibase prefix 'b' = base32 lowercase no padding
  return "b" + base32Encode(cidBytes);
}

/**
 * Inverse of bulletinCidFromDigest. Parses a base32-encoded CIDv1 and returns
 * the underlying 32-byte digest plus the codec discriminator.
 *
 * Useful when the user pastes a CID from the Console UI and we need to push
 * the matching `(cidDigest, cidCodec)` pair to DatumCampaigns.setBulletinCreative.
 */
export function bulletinDigestFromCid(cid: string): { digestHex: string; codec: BulletinCodec } {
  if (!cid.startsWith("b")) {
    throw new Error("Only base32 multibase CIDs (prefix 'b') are supported");
  }
  const bytes = base32Decode(cid.slice(1));
  // CIDv1 layout = 1 + 1 + 3 + 1 + 32 = 38 bytes
  if (bytes.length !== 38) {
    throw new Error(`Expected 38 bytes for CIDv1 with Blake2b-256, got ${bytes.length}`);
  }
  if (bytes[0] !== 0x01) throw new Error("Not a CIDv1");
  const codecByte = bytes[1];
  let codec: BulletinCodec;
  if (codecByte === MULTICODEC[BulletinCodec.Raw]) codec = BulletinCodec.Raw;
  else if (codecByte === MULTICODEC[BulletinCodec.DagPb]) codec = BulletinCodec.DagPb;
  else throw new Error(`Unsupported codec 0x${codecByte.toString(16)}`);
  // Verify multihash prefix matches Blake2b-256
  if (bytes[2] !== BLAKE2B_256_VARINT[0] || bytes[3] !== BLAKE2B_256_VARINT[1] || bytes[4] !== BLAKE2B_256_VARINT[2]) {
    throw new Error("Expected Blake2b-256 multihash");
  }
  if (bytes[5] !== BLAKE2B_256_DIGEST_LEN) {
    throw new Error("Expected 32-byte digest length");
  }
  const digest = bytes.slice(6);
  return { digestHex: bytesToHex(digest), codec };
}

// ── Gateway URL builder ───────────────────────────────────────────────────────

/**
 * Build the Paseo Bulletin gateway URL for a stored creative.
 *
 * @param digestHex  0x-prefixed 32-byte digest (zero hex = no Bulletin ref)
 * @param codec      BulletinCodec discriminator
 * @param gateway    Optional gateway override (defaults to PASEO_BULLETIN_GATEWAY)
 * @returns          Full URL, or null if the digest is zero / inputs invalid
 */
export function bulletinGatewayUrl(
  digestHex: string,
  codec: BulletinCodec,
  gateway: string = PASEO_BULLETIN_GATEWAY,
): string | null {
  if (!digestHex || digestHex === "0x" + "0".repeat(64)) return null;
  try {
    const parsed = new URL(gateway);
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!isLocal && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  let cid: string;
  try {
    cid = bulletinCidFromDigest(digestHex, codec);
  } catch {
    return null;
  }
  const gw = gateway.endsWith("/") ? gateway : gateway + "/";
  return gw + cid;
}

// ── BulletinRef helpers ───────────────────────────────────────────────────────

/** Mirror of the Solidity `BulletinRef` struct shape returned by
 *  `DatumCampaigns.getBulletinCreative(id)`. */
export interface BulletinRef {
  cidDigest: string;             // 0x...32-byte hex
  cidCodec: number;              // 0 = raw, 1 = dag-pb
  bulletinBlock: number;
  bulletinIndex: number;
  expiryHubBlock: bigint;
  retentionHorizonBlock: bigint;
  version: number;
}

/** Returns true when the ref points to a real, unexpired Bulletin Chain entry. */
export function hasActiveBulletinRef(ref: BulletinRef | null | undefined): boolean {
  if (!ref) return false;
  return !!ref.cidDigest && ref.cidDigest !== "0x" + "0".repeat(64);
}

/** Returns true when retention is within the lead window — the frontend can
 *  surface a "Renew now" prompt. */
export function isBulletinRenewalDue(
  ref: BulletinRef,
  currentHubBlock: bigint,
  leadBlocks: bigint = BULLETIN_RENEWAL_LEAD_BLOCKS,
): boolean {
  if (!hasActiveBulletinRef(ref)) return false;
  if (ref.expiryHubBlock <= currentHubBlock) return false;
  return ref.expiryHubBlock - currentHubBlock <= leadBlocks;
}

/** Hub-block estimate of when the next renewal would push expiry to. */
export function projectedExpiryAfterRenewal(currentHubBlock: bigint): bigint {
  return currentHubBlock + MAX_RETENTION_ADVANCE_BLOCKS;
}

// ── Internal utilities ────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
