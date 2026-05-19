import "./chromeMock";
import {
  assetIdToAddress,
  getAssetMetadata,
  isNativeAssetAddress,
  getKnownAssets,
  popularAssets,
  searchAssets,
  registerAssets,
  KNOWN_ASSETS,
  type NativeAsset,
} from "@shared/assetRegistry";

// ── assetIdToAddress ──────────────────────────────────────────────────────────

describe("assetIdToAddress", () => {
  test("trust-backed (default): USDt 1984", () => {
    expect(assetIdToAddress(1984)).toBe("0x000007C000000000000000000000000001200000");
  });

  test("trust-backed explicit: USDC 1337", () => {
    expect(assetIdToAddress(1337, "trust-backed")).toBe("0x0000053900000000000000000000000001200000");
  });

  test("foreign suffix 0220", () => {
    expect(assetIdToAddress(1, "foreign")).toBe("0x0000000100000000000000000000000002200000");
  });

  test("pool suffix 0320", () => {
    expect(assetIdToAddress(1, "pool")).toBe("0x0000000100000000000000000000000003200000");
  });

  test("zero asset ID", () => {
    expect(assetIdToAddress(0)).toBe("0x0000000000000000000000000000000001200000");
  });

  test("large asset ID 31337", () => {
    // 31337 = 0x7A69
    expect(assetIdToAddress(31337)).toBe("0x00007A6900000000000000000000000001200000");
  });

  test("output is always 42 chars (0x + 40 hex)", () => {
    for (const id of [0, 1, 255, 1984, 65535, 0xFFFFFFFF]) {
      const addr = assetIdToAddress(id);
      expect(addr).toHaveLength(42);
      expect(addr.startsWith("0x")).toBe(true);
    }
  });
});

// ── getAssetMetadata ──────────────────────────────────────────────────────────

describe("getAssetMetadata", () => {
  test("USDt returns correct metadata", () => {
    const addr = assetIdToAddress(1984);
    const meta = getAssetMetadata(addr);
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe("USDt");
    expect(meta!.decimals).toBe(6);
    expect(meta!.type).toBe("trust-backed");
    expect(meta!.network).toBe("polkadot");
    expect(meta!.category).toBe("stablecoin");
    expect(meta!.popular).toBe(true);
  });

  test("USDC returns correct metadata", () => {
    const meta = getAssetMetadata(assetIdToAddress(1337));
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe("USDC");
    expect(meta!.decimals).toBe(6);
  });

  test("WETH (foreign) returns correct metadata", () => {
    const meta = getAssetMetadata(assetIdToAddress(100, "foreign"));
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe("WETH");
    expect(meta!.decimals).toBe(18);
    expect(meta!.type).toBe("foreign");
  });

  test("unknown ERC-20 address returns null", () => {
    expect(getAssetMetadata("0x1234567890123456789012345678901234567890")).toBeNull();
  });

  test("zero address returns null", () => {
    expect(getAssetMetadata("0x0000000000000000000000000000000000000000")).toBeNull();
  });

  test("lookup is case-insensitive", () => {
    const addr = assetIdToAddress(1984);
    const upper = addr.toUpperCase().replace("0X", "0x");
    const lower = addr.toLowerCase();
    expect(getAssetMetadata(upper)?.symbol).toBe("USDt");
    expect(getAssetMetadata(lower)?.symbol).toBe("USDt");
  });
});

// ── isNativeAssetAddress ──────────────────────────────────────────────────────

describe("isNativeAssetAddress", () => {
  test("returns true for known trust-backed asset", () => {
    expect(isNativeAssetAddress(assetIdToAddress(1984))).toBe(true);
  });

  test("returns true for known foreign asset", () => {
    expect(isNativeAssetAddress(assetIdToAddress(1, "foreign"))).toBe(true);
  });

  test("returns false for random EVM address", () => {
    expect(isNativeAssetAddress("0xdead000000000000000000000000000000000001")).toBe(false);
  });

  test("case-insensitive", () => {
    const addr = assetIdToAddress(1337).toUpperCase().replace("0X", "0x");
    expect(isNativeAssetAddress(addr)).toBe(true);
  });
});

// ── getKnownAssets ────────────────────────────────────────────────────────────

describe("getKnownAssets", () => {
  test("returns all built-in assets when no network filter", () => {
    const all = getKnownAssets();
    expect(all.length).toBeGreaterThanOrEqual(KNOWN_ASSETS.length);
  });

  test("polkadot filter returns only polkadot assets", () => {
    const polkadot = getKnownAssets("polkadot");
    expect(polkadot.every((a) => a.network === "polkadot")).toBe(true);
    expect(polkadot.length).toBeGreaterThan(0);
  });

  test("kusama filter returns only kusama assets", () => {
    const kusama = getKnownAssets("kusama");
    expect(kusama.every((a) => a.network === "kusama")).toBe(true);
    expect(kusama.length).toBeGreaterThan(0);
  });

  test("polkadot + kusama counts add up to total", () => {
    const all = getKnownAssets();
    const polkadot = getKnownAssets("polkadot");
    const kusama = getKnownAssets("kusama");
    expect(polkadot.length + kusama.length).toBe(all.length);
  });
});

// ── popularAssets ─────────────────────────────────────────────────────────────

describe("popularAssets", () => {
  test("all returned assets have popular=true", () => {
    expect(popularAssets().every((a) => a.popular)).toBe(true);
  });

  test("includes USDt and USDC", () => {
    const symbols = popularAssets().map((a) => a.symbol);
    expect(symbols).toContain("USDt");
    expect(symbols).toContain("USDC");
  });

  test("network filter works", () => {
    const polkadot = popularAssets("polkadot");
    expect(polkadot.every((a) => a.network === "polkadot")).toBe(true);
  });
});

// ── searchAssets ──────────────────────────────────────────────────────────────

describe("searchAssets", () => {
  test("empty query returns all assets", () => {
    const all = searchAssets("");
    expect(all.length).toBe(getKnownAssets().length);
  });

  test("symbol search: 'USDT' finds USDt (case-insensitive)", () => {
    const results = searchAssets("USDT");
    expect(results.some((a) => a.symbol === "USDt")).toBe(true);
  });

  test("name search: 'tether' finds USDt", () => {
    const results = searchAssets("tether");
    expect(results.some((a) => a.symbol === "USDt")).toBe(true);
  });

  test("exact asset ID search: '1984' finds USDt", () => {
    const results = searchAssets("1984");
    expect(results.some((a) => a.symbol === "USDt")).toBe(true);
  });

  test("address substring search", () => {
    const addr = assetIdToAddress(1984);
    const results = searchAssets(addr.slice(2, 12)); // partial hex
    expect(results.some((a) => a.symbol === "USDt")).toBe(true);
  });

  test("no match returns empty array", () => {
    expect(searchAssets("ZZZNOMATCH")).toHaveLength(0);
  });

  test("network filter narrows results", () => {
    const all = searchAssets("a"); // broad match
    const polkadot = searchAssets("a", "polkadot");
    expect(polkadot.every((a) => a.network === "polkadot")).toBe(true);
    expect(polkadot.length).toBeLessThanOrEqual(all.length);
  });
});

// ── registerAssets ────────────────────────────────────────────────────────────

describe("registerAssets", () => {
  const testAsset: NativeAsset = {
    assetId: 99999,
    symbol: "TEST",
    name: "Test Token",
    decimals: 12,
    type: "trust-backed",
    network: "polkadot",
    category: "community",
    address: assetIdToAddress(99999, "trust-backed"),
  };

  test("newly registered asset is found by getAssetMetadata", () => {
    registerAssets([testAsset]);
    const meta = getAssetMetadata(testAsset.address);
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe("TEST");
  });

  test("duplicate registration is silently ignored (no duplicates in list)", () => {
    const countBefore = getKnownAssets().length;
    registerAssets([testAsset]);
    expect(getKnownAssets().length).toBe(countBefore); // no increase
  });

  test("isNativeAssetAddress returns true for newly registered asset", () => {
    expect(isNativeAssetAddress(testAsset.address)).toBe(true);
  });

  test("registered asset appears in searchAssets", () => {
    const results = searchAssets("TEST");
    expect(results.some((a) => a.symbol === "TEST")).toBe(true);
  });
});
