import "./chromeMock";
import { parseDOT, formatDOT } from "@shared/dot";

describe("parseDOT", () => {
  test("1 DOT = 10^10 planck", () => {
    expect(parseDOT("1")).toBe(10_000_000_000n);
  });

  test("0.5 DOT", () => {
    expect(parseDOT("0.5")).toBe(5_000_000_000n);
  });

  test("0.01 DOT", () => {
    expect(parseDOT("0.01")).toBe(100_000_000n);
  });

  test("100 DOT", () => {
    expect(parseDOT("100")).toBe(1_000_000_000_000n);
  });

  test("0 DOT", () => {
    expect(parseDOT("0")).toBe(0n);
  });

  test("fractional with all 10 decimals", () => {
    expect(parseDOT("0.0000000001")).toBe(1n); // 1 planck
  });

  test("excess decimals truncated", () => {
    // 0.00000000019 should truncate to 0.0000000001 = 1 planck
    expect(parseDOT("0.00000000019")).toBe(1n);
  });

  test("large amount", () => {
    expect(parseDOT("1000000")).toBe(10_000_000_000_000_000n);
  });
});

describe("formatDOT", () => {
  test("10^10 planck = 1 DOT", () => {
    expect(formatDOT(10_000_000_000n)).toBe("1");
  });

  test("5*10^9 planck = 0.5 DOT", () => {
    expect(formatDOT(5_000_000_000n)).toBe("0.5");
  });

  test("1 planck", () => {
    expect(formatDOT(1n)).toBe("0.0000000001");
  });

  test("0 planck", () => {
    expect(formatDOT(0n)).toBe("0");
  });

  test("round trip", () => {
    const amounts = ["1", "0.5", "0.01", "100", "0.0000000001"];
    for (const a of amounts) {
      expect(formatDOT(parseDOT(a))).toBe(a);
    }
  });

  test("trailing zeros stripped", () => {
    expect(formatDOT(100_000_000n)).toBe("0.01");
  });
});
