import "./chromeMock";
import { parseDOT, formatDOT, formatDotWei } from "@shared/dot";

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

describe("formatDotWei", () => {
  const DOT = 10n ** 18n; // 1 DOT in wei

  test("zero", () => {
    expect(formatDotWei(0n)).toBe("0");
  });

  test("whole DOT", () => {
    expect(formatDotWei(DOT)).toBe("1");
    expect(formatDotWei(42n * DOT)).toBe("42");
  });

  test("normal fractions show up to 4 decimals, trimmed", () => {
    expect(formatDotWei(DOT / 2n)).toBe("0.5");
    expect(formatDotWei(DOT / 100n)).toBe("0.01");
    expect(formatDotWei(123_456n * (DOT / 1_000_000n))).toBe("0.1234"); // 0.123456 → 4dp
  });

  test("dust below 0.0001 falls back to significant figures, not 0", () => {
    // 22_275_000 wei = 0.000000000022275 DOT → 4 sig figs from first non-zero
    expect(formatDotWei(22_275_000n)).toBe("0.00000000002227");
    // single planck-scale dust still visible
    expect(formatDotWei(1n)).toBe("0.000000000000000001");
  });

  test("sigFigs is configurable", () => {
    expect(formatDotWei(22_275_000n, 3)).toBe("0.0000000000222");
    expect(formatDotWei(22_275_000n, 5)).toBe("0.000000000022275");
  });

  test("a non-zero balance never renders as 0", () => {
    for (const w of [1n, 7n, 999n, 22_275_000n, 5n * 10n ** 13n]) {
      expect(formatDotWei(w)).not.toBe("0");
      expect(formatDotWei(w)).not.toBe("0.0");
    }
  });

  test("negative", () => {
    expect(formatDotWei(-DOT)).toBe("-1");
  });
});
