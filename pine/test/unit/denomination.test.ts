import { describe, it, expect } from "vitest";
import {
  planckToWei,
  weiToPlanck,
  roundToSafePlanck,
  toHex,
  toBigInt,
} from "../../src/codec/denomination.js";

describe("denomination", () => {
  describe("planckToWei", () => {
    it("converts 0 planck to 0 wei", () => {
      expect(planckToWei(0n)).toBe(0n);
    });

    it("converts 1 planck to 10^8 wei", () => {
      expect(planckToWei(1n)).toBe(100_000_000n);
    });

    it("converts 1 DOT (10^10 planck) to 10^18 wei", () => {
      expect(planckToWei(10n ** 10n)).toBe(10n ** 18n);
    });

    it("converts 100 DOT", () => {
      expect(planckToWei(100n * 10n ** 10n)).toBe(100n * 10n ** 18n);
    });
  });

  describe("weiToPlanck", () => {
    it("converts 0 wei to 0 planck", () => {
      expect(weiToPlanck(0n)).toBe(0n);
    });

    it("converts 10^18 wei to 10^10 planck (1 DOT)", () => {
      expect(weiToPlanck(10n ** 18n)).toBe(10n ** 10n);
    });

    it("truncates sub-planck amounts", () => {
      // 99 wei < 10^8 wei/planck → 0 planck
      expect(weiToPlanck(99n)).toBe(0n);
    });

    it("roundtrips whole planck values", () => {
      const planck = 12345678901234n;
      expect(weiToPlanck(planckToWei(planck))).toBe(planck);
    });
  });

  describe("roundToSafePlanck", () => {
    it("leaves safe values unchanged", () => {
      expect(roundToSafePlanck(1_000_000n)).toBe(1_000_000n);
      expect(roundToSafePlanck(1_499_999n)).toBe(1_499_999n);
    });

    it("rounds down unsafe values (>= 500_000 remainder)", () => {
      expect(roundToSafePlanck(1_500_000n)).toBe(1_000_000n);
      expect(roundToSafePlanck(1_999_999n)).toBe(1_000_000n);
    });

    it("handles zero", () => {
      expect(roundToSafePlanck(0n)).toBe(0n);
    });
  });

  describe("toHex", () => {
    it("formats 0 as 0x0", () => {
      expect(toHex(0n)).toBe("0x0");
    });

    it("formats 255 as 0xff", () => {
      expect(toHex(255n)).toBe("0xff");
    });

    it("formats large values", () => {
      expect(toHex(10n ** 18n)).toBe("0xde0b6b3a7640000");
    });
  });

  describe("toBigInt", () => {
    it("parses hex strings", () => {
      expect(toBigInt("0xff")).toBe(255n);
      expect(toBigInt("0x0")).toBe(0n);
    });

    it("parses decimal strings", () => {
      expect(toBigInt("1000")).toBe(1000n);
    });

    it("passes through bigints", () => {
      expect(toBigInt(42n)).toBe(42n);
    });

    it("converts numbers", () => {
      expect(toBigInt(123)).toBe(123n);
    });
  });
});
