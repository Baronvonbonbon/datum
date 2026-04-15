import { describe, it, expect, beforeAll } from "vitest";
import {
  initXxhash,
  twox128,
  storageKeyPrefix,
  systemEventsKey,
} from "../../src/codec/storageKeys.js";
import { bytesToHex } from "../../src/codec/scale.js";

describe("storageKeys", () => {
  beforeAll(async () => {
    await initXxhash();
  });

  describe("twox128", () => {
    it("produces 16 bytes", () => {
      const result = twox128(new TextEncoder().encode("System"));
      expect(result.length).toBe(16);
    });

    it("is deterministic", () => {
      const input = new TextEncoder().encode("System");
      const a = twox128(input);
      const b = twox128(input);
      expect(bytesToHex(a)).toBe(bytesToHex(b));
    });

    it("produces known hash for 'System'", () => {
      // Known substrate twox128("System") = 26aa394eea5630e07c48ae0c9558cef7
      const result = twox128(new TextEncoder().encode("System"));
      expect(bytesToHex(result)).toBe("26aa394eea5630e07c48ae0c9558cef7");
    });

    it("produces known hash for 'Events'", () => {
      const result = twox128(new TextEncoder().encode("Events"));
      expect(bytesToHex(result)).toBe("80d41e5e16056765bc8461851072c9d7");
    });

    it("produces known hash for 'Account'", () => {
      const result = twox128(new TextEncoder().encode("Account"));
      expect(bytesToHex(result)).toBe("b99d880ec681799c0cf30e8886371da9");
    });
  });

  describe("storageKeyPrefix", () => {
    it("concatenates two twox128 hashes", () => {
      const key = storageKeyPrefix("System", "Events");
      // Should be twox128("System") + twox128("Events") = 64 hex chars after 0x
      expect(key.startsWith("0x")).toBe(true);
      expect(key.length).toBe(2 + 64); // 0x + 32 bytes as hex
    });
  });

  describe("systemEventsKey", () => {
    it("returns System.Events prefix", () => {
      const key = systemEventsKey();
      // twox128("System") + twox128("Events")
      expect(key).toBe(
        "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7",
      );
    });
  });
});
