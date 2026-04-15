import { describe, it, expect } from "vitest";
import {
  encodeCompact,
  decodeCompact,
  encodeU256,
  decodeU256,
  encodeH160,
  decodeH160,
  encodeH256,
  encodeBytes,
  hexToBytes,
  bytesToHex,
  concatBytes,
} from "../../src/codec/scale.js";

describe("scale codec", () => {
  describe("compact encoding", () => {
    it("single-byte mode (0–63)", () => {
      expect(encodeCompact(0)).toEqual(new Uint8Array([0]));
      expect(encodeCompact(1)).toEqual(new Uint8Array([4]));
      expect(encodeCompact(63)).toEqual(new Uint8Array([252]));
    });

    it("two-byte mode (64–16383)", () => {
      const encoded = encodeCompact(64);
      expect(encoded.length).toBe(2);
      const [val] = decodeCompact(encoded);
      expect(val).toBe(64);
    });

    it("four-byte mode (16384–2^30-1)", () => {
      const encoded = encodeCompact(16384);
      expect(encoded.length).toBe(4);
      const [val] = decodeCompact(encoded);
      expect(val).toBe(16384);
    });

    it("roundtrips various values", () => {
      for (const v of [0, 1, 63, 64, 255, 1000, 16383, 16384, 65535, 100000]) {
        const encoded = encodeCompact(v);
        const [decoded, len] = decodeCompact(encoded);
        expect(decoded).toBe(v);
        expect(len).toBe(encoded.length);
      }
    });
  });

  describe("U256", () => {
    it("encodes/decodes 0", () => {
      const encoded = encodeU256(0n);
      expect(encoded.length).toBe(32);
      expect(encoded.every((b) => b === 0)).toBe(true);
      expect(decodeU256(encoded)).toBe(0n);
    });

    it("encodes/decodes 1", () => {
      const encoded = encodeU256(1n);
      expect(encoded[0]).toBe(1);
      expect(encoded.slice(1).every((b) => b === 0)).toBe(true);
      expect(decodeU256(encoded)).toBe(1n);
    });

    it("encodes little-endian", () => {
      const encoded = encodeU256(256n); // 0x100
      expect(encoded[0]).toBe(0);
      expect(encoded[1]).toBe(1);
      expect(decodeU256(encoded)).toBe(256n);
    });

    it("roundtrips large values", () => {
      const v = 10n ** 18n; // 1 ETH in wei
      expect(decodeU256(encodeU256(v))).toBe(v);
    });
  });

  describe("H160", () => {
    it("encodes a valid address", () => {
      const addr = "0x94CC36412EE0c099BfE7D61a35092e40342F62D7";
      const encoded = encodeH160(addr);
      expect(encoded.length).toBe(20);
      const decoded = decodeH160(encoded);
      expect(decoded.toLowerCase()).toBe(addr.toLowerCase());
    });

    it("rejects invalid length", () => {
      expect(() => encodeH160("0x1234")).toThrow("Invalid H160");
    });
  });

  describe("H256", () => {
    it("encodes a valid hash", () => {
      const hash = "0x" + "ab".repeat(32);
      const encoded = encodeH256(hash);
      expect(encoded.length).toBe(32);
      expect(encoded.every((b) => b === 0xab)).toBe(true);
    });
  });

  describe("encodeBytes (Vec<u8>)", () => {
    it("encodes empty bytes", () => {
      const encoded = encodeBytes(new Uint8Array(0));
      expect(encoded).toEqual(new Uint8Array([0])); // compact(0)
    });

    it("encodes with compact length prefix", () => {
      const data = new Uint8Array([1, 2, 3]);
      const encoded = encodeBytes(data);
      expect(encoded[0]).toBe(12); // compact(3) = 3 << 2 = 12
      expect(encoded.slice(1)).toEqual(data);
    });
  });

  describe("hex utilities", () => {
    it("hexToBytes / bytesToHex roundtrip", () => {
      const hex = "deadbeef";
      const bytes = hexToBytes(hex);
      expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      expect(bytesToHex(bytes)).toBe(hex);
    });

    it("handles 0x prefix", () => {
      const bytes = hexToBytes("0xaabb");
      expect(bytes).toEqual(new Uint8Array([0xaa, 0xbb]));
    });
  });

  describe("concatBytes", () => {
    it("concatenates arrays", () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4, 5]);
      const result = concatBytes(a, b);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("handles empty arrays", () => {
      const result = concatBytes(new Uint8Array(0), new Uint8Array([1]));
      expect(result).toEqual(new Uint8Array([1]));
    });
  });
});
