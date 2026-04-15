import { describe, it, expect } from "vitest";
import { buildEthTransactExtrinsic } from "../../src/codec/extrinsic.js";

describe("extrinsic builder", () => {
  it("produces a valid unsigned extrinsic structure", () => {
    // Minimal raw tx (just some bytes)
    const rawTx = "0xdeadbeef";
    const extrinsic = buildEthTransactExtrinsic(rawTx);

    expect(extrinsic.startsWith("0x")).toBe(true);

    // Decode and verify structure
    const hex = extrinsic.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }

    // First byte(s): compact length
    // Then: 0x04 (V4 unsigned)
    // Then: pallet index (65) | call index (3)
    // Then: SCALE Vec<u8> of raw tx

    // Skip compact length prefix
    const mode = bytes[0] & 0x03;
    let offset = mode === 0 ? 1 : mode === 1 ? 2 : 4;

    // Extrinsic version
    expect(bytes[offset]).toBe(0x04); // V4 unsigned
    offset++;

    // Pallet index
    expect(bytes[offset]).toBe(65); // Default Revive pallet index
    offset++;

    // Call index
    expect(bytes[offset]).toBe(3); // Default eth_transact call index
    offset++;

    // SCALE Vec<u8> — compact length of 4 (0xdeadbeef = 4 bytes)
    expect(bytes[offset]).toBe(4 << 2); // compact(4) = 0x10
    offset++;

    // Payload bytes
    expect(bytes[offset]).toBe(0xde);
    expect(bytes[offset + 1]).toBe(0xad);
    expect(bytes[offset + 2]).toBe(0xbe);
    expect(bytes[offset + 3]).toBe(0xef);
  });

  it("accepts custom pallet/call indices", () => {
    const rawTx = "0xaa";
    const extrinsic = buildEthTransactExtrinsic(rawTx, {
      revivePalletIndex: 42,
      ethTransactCallIndex: 7,
    });

    const hex = extrinsic.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }

    // Skip compact length + version byte
    const mode = bytes[0] & 0x03;
    let offset = (mode === 0 ? 1 : mode === 1 ? 2 : 4) + 1;

    expect(bytes[offset]).toBe(42); // custom pallet index
    expect(bytes[offset + 1]).toBe(7); // custom call index
  });

  it("handles larger payloads", () => {
    // 256 bytes of raw tx data
    const rawTx = "0x" + "ab".repeat(256);
    const extrinsic = buildEthTransactExtrinsic(rawTx);
    expect(extrinsic.startsWith("0x")).toBe(true);
    // Should be valid hex
    expect(extrinsic.length).toBeGreaterThan(2 + 256 * 2);
  });
});
