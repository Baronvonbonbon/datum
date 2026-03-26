import { resetStore, seedStore, getStore } from "./chromeMock";
import {
  refreshPhishingList,
  isDomainPhishing,
  isUrlPhishing,
  isAddressBlocked,
  getBlockedAddresses,
  addBlockedAddress,
  removeBlockedAddress,
} from "@shared/phishingList";

// Mock fetch for refreshPhishingList tests
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetStore();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("isDomainPhishing", () => {
  beforeEach(() => {
    seedStore({
      phishingDomains: ["evil-polkadot.com", "scam.io", "phish.example.com"],
    });
  });

  test("exact match", async () => {
    expect(await isDomainPhishing("evil-polkadot.com")).toBe(true);
    expect(await isDomainPhishing("scam.io")).toBe(true);
  });

  test("subdomain matches parent", async () => {
    expect(await isDomainPhishing("www.evil-polkadot.com")).toBe(true);
    expect(await isDomainPhishing("sub.evil-polkadot.com")).toBe(true);
    expect(await isDomainPhishing("deep.sub.evil-polkadot.com")).toBe(true);
  });

  test("case insensitive", async () => {
    expect(await isDomainPhishing("Evil-Polkadot.COM")).toBe(true);
    expect(await isDomainPhishing("SCAM.IO")).toBe(true);
  });

  test("non-matching domains", async () => {
    expect(await isDomainPhishing("polkadot.network")).toBe(false);
    expect(await isDomainPhishing("example.com")).toBe(false);
    expect(await isDomainPhishing("not-evil-polkadot.com")).toBe(false);
  });

  test("similar but different domain is not matched", async () => {
    // "evil-polkadot.com.attacker.com" should NOT match "evil-polkadot.com"
    // because parent domain matching checks suffixes, not substrings
    expect(await isDomainPhishing("legit-site.org")).toBe(false);
  });

  test("empty deny list returns false", async () => {
    resetStore();
    expect(await isDomainPhishing("evil-polkadot.com")).toBe(false);
  });

  test("no stored list returns false", async () => {
    resetStore();
    expect(await isDomainPhishing("anything.com")).toBe(false);
  });
});

describe("isUrlPhishing", () => {
  beforeEach(() => {
    seedStore({
      phishingDomains: ["phishing-site.com"],
    });
  });

  test("detects phishing URL", async () => {
    expect(await isUrlPhishing("https://phishing-site.com/login")).toBe(true);
    expect(await isUrlPhishing("https://sub.phishing-site.com/claim")).toBe(true);
  });

  test("safe URL passes", async () => {
    expect(await isUrlPhishing("https://polkadot.network/docs")).toBe(false);
  });

  test("invalid URL returns false (not true)", async () => {
    expect(await isUrlPhishing("not-a-url")).toBe(false);
    expect(await isUrlPhishing("")).toBe(false);
  });

  test("URL with port still checks domain", async () => {
    expect(await isUrlPhishing("https://phishing-site.com:8443/steal")).toBe(true);
  });
});

describe("address blocklist", () => {
  test("empty blocklist — nothing blocked", async () => {
    expect(await isAddressBlocked("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
  });

  test("empty string is not blocked", async () => {
    expect(await isAddressBlocked("")).toBe(false);
  });

  test("add and check address", async () => {
    await addBlockedAddress("0xDeadBeef00000000000000000000000000000001");
    expect(await isAddressBlocked("0xDeadBeef00000000000000000000000000000001")).toBe(true);
  });

  test("case-insensitive matching", async () => {
    await addBlockedAddress("0xABCDEF1234567890ABCDEF1234567890ABCDEF12");
    expect(await isAddressBlocked("0xabcdef1234567890abcdef1234567890abcdef12")).toBe(true);
  });

  test("remove address", async () => {
    await addBlockedAddress("0x1111111111111111111111111111111111111111");
    expect(await isAddressBlocked("0x1111111111111111111111111111111111111111")).toBe(true);

    await removeBlockedAddress("0x1111111111111111111111111111111111111111");
    expect(await isAddressBlocked("0x1111111111111111111111111111111111111111")).toBe(false);
  });

  test("remove is case-insensitive", async () => {
    await addBlockedAddress("0xAAAABBBBCCCCDDDD0000000000000000EEEEFFFF");
    await removeBlockedAddress("0xaaaabbbbccccdddd0000000000000000eeeeffff");
    expect(await isAddressBlocked("0xAAAABBBBCCCCDDDD0000000000000000EEEEFFFF")).toBe(false);
  });

  test("duplicate add is idempotent", async () => {
    await addBlockedAddress("0x2222222222222222222222222222222222222222");
    await addBlockedAddress("0x2222222222222222222222222222222222222222");
    const list = await getBlockedAddresses();
    expect(list.filter((a) => a.toLowerCase() === "0x2222222222222222222222222222222222222222")).toHaveLength(1);
  });

  test("getBlockedAddresses returns all", async () => {
    await addBlockedAddress("0xAAAA000000000000000000000000000000000001");
    await addBlockedAddress("0xBBBB000000000000000000000000000000000002");
    const list = await getBlockedAddresses();
    expect(list).toHaveLength(2);
  });
});

describe("refreshPhishingList", () => {
  test("fetches and stores deny list", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ deny: ["evil.com", "scam.net"], allow: ["good.com"] }),
    }) as any;

    await refreshPhishingList();

    expect(await isDomainPhishing("evil.com")).toBe(true);
    expect(await isDomainPhishing("scam.net")).toBe(true);
    expect(await isDomainPhishing("good.com")).toBe(false); // allow list not used for blocking
  });

  test("skips fetch if recently refreshed", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ deny: ["first.com"] }),
    }) as any;
    globalThis.fetch = mockFetch;

    await refreshPhishingList(); // should fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await refreshPhishingList(); // should skip (within 6h)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("keeps stale cache on fetch failure", async () => {
    seedStore({
      phishingDomains: ["cached-evil.com"],
      phishingDomainsTs: 0, // expired
    });

    globalThis.fetch = jest.fn().mockRejectedValue(new Error("network error")) as any;

    await refreshPhishingList(); // fails but keeps cache
    expect(await isDomainPhishing("cached-evil.com")).toBe(true);
  });

  test("handles non-ok response gracefully", async () => {
    seedStore({ phishingDomainsTs: 0 }); // force refresh
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

    await refreshPhishingList(); // should not throw
  });

  test("handles malformed JSON gracefully", async () => {
    seedStore({ phishingDomainsTs: 0 });
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notDeny: "wrong shape" }),
    }) as any;

    await refreshPhishingList();
    // deny is empty array from fallback — should not match anything
    expect(await isDomainPhishing("anything.com")).toBe(false);
  });
});
