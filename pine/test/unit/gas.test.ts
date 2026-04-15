import { describe, it, expect } from "vitest";
import { weightToGas, gasToWeight } from "../../src/codec/gas.js";

describe("gas codec", () => {
  it("converts weight to gas (default 1000:1)", () => {
    expect(weightToGas(1000n)).toBe(1n);
    expect(weightToGas(5000n)).toBe(5n);
    expect(weightToGas(0n)).toBe(0n);
  });

  it("converts gas to weight (default 1000:1)", () => {
    expect(gasToWeight(1n)).toBe(1000n);
    expect(gasToWeight(5n)).toBe(5000n);
    expect(gasToWeight(0n)).toBe(0n);
  });

  it("roundtrips", () => {
    const gas = 21000n;
    expect(weightToGas(gasToWeight(gas))).toBe(gas);
  });

  it("truncates sub-gas weight", () => {
    expect(weightToGas(999n)).toBe(0n);
    expect(weightToGas(1500n)).toBe(1n);
  });
});
