// ── Minimal SCALE encoding/decoding for pallet-revive runtime API calls ──
//
// We only need enough SCALE to encode/decode ReviveApi parameters and results.
// For complex types, defer to polkadot-api's codec when available.

/** Encode a Uint8Array as SCALE Compact<u32> length-prefixed bytes */
export function encodeBytes(data: Uint8Array): Uint8Array {
  const len = encodeCompact(data.length);
  const result = new Uint8Array(len.length + data.length);
  result.set(len, 0);
  result.set(data, len.length);
  return result;
}

/** Encode a compact integer (SCALE Compact<u32>) */
export function encodeCompact(value: number): Uint8Array {
  if (value < 0) throw new Error("Compact cannot be negative");

  if (value <= 0x3f) {
    // single-byte mode
    return new Uint8Array([value << 2]);
  }
  if (value <= 0x3fff) {
    // two-byte mode
    const v = (value << 2) | 0x01;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  if (value <= 0x3fffffff) {
    // four-byte mode
    const v = (value << 2) | 0x02;
    return new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >> 24) & 0xff,
    ]);
  }
  // big-integer mode (up to 2^536 - 1)
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining = remaining >> 8;
  }
  const header = ((bytes.length - 4) << 2) | 0x03;
  return new Uint8Array([header, ...bytes]);
}

/** Decode a compact integer from SCALE bytes. Returns [value, bytesConsumed]. */
export function decodeCompact(data: Uint8Array, offset = 0): [number, number] {
  const mode = data[offset] & 0x03;
  if (mode === 0) return [data[offset] >> 2, 1];
  if (mode === 1) {
    const v = (data[offset] | (data[offset + 1] << 8)) >> 2;
    return [v, 2];
  }
  if (mode === 2) {
    const v =
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>>
      2;
    return [v, 4];
  }
  // Big-integer mode
  const numBytes = (data[offset] >> 2) + 4;
  let value = 0;
  for (let i = numBytes - 1; i >= 0; i--) {
    value = value * 256 + data[offset + 1 + i];
  }
  return [value, 1 + numBytes];
}

/** Encode a U256 as 32 little-endian bytes */
export function encodeU256(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/** Decode a U256 from 32 little-endian bytes */
export function decodeU256(data: Uint8Array, offset = 0): bigint {
  let value = 0n;
  for (let i = 31; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }
  return value;
}

/** Encode an H160 (Ethereum address) — 20 bytes */
export function encodeH160(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 40) throw new Error(`Invalid H160: ${hex}`);
  return hexToBytes(clean);
}

/** Decode an H160 from 20 bytes */
export function decodeH160(data: Uint8Array, offset = 0): string {
  return "0x" + bytesToHex(data.slice(offset, offset + 20));
}

/** Encode an H256 — 32 bytes */
export function encodeH256(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`Invalid H256: ${hex}`);
  return hexToBytes(clean);
}

/** Hex string to Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Uint8Array to hex string (no 0x prefix) */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Concatenate multiple Uint8Arrays */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((a, b) => a + b.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
