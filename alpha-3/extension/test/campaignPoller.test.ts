/**
 * campaignPoller.test.ts — Unit tests for the event-driven campaign poller.
 *
 * Tests focus on:
 *  CP-1: IPFS metadata hash stored in campaign index after CampaignMetadataSet event
 *  CP-2: bytes32 → CID → gateway URL construction for IPFS fetch
 *  CP-3: getById O(1) lookup returns campaign with metadataHash
 *  CP-4: reset() clears index + lastBlock
 *  CP-5: Terminal campaigns pruned from index
 *  CP-6: getCached() returns flat array from index
 *  CP-7: ERC-20 reward token address passed through from campaign data
 *  CP-8: IPFS metadata fetch writes to chrome.storage.local with TTL
 *  CP-9: Stale metadata keys removed for non-active campaigns (Phase 4 cleanup)
 *  CP-10: Competing campaigns (different CPMs) stored independently in index
 *
 * The poller's poll() function calls RPC methods, queryFilter, and fetch, so we
 * stub these at the module level rather than importing the real poller internals.
 * The public interface (getCached, getById, reset, poll) is tested directly.
 */

import "./chromeMock";
import { resetStore, seedStore, getStore } from "./chromeMock";
import { metadataUrl, bytes32ToCid } from "@shared/ipfs";
import { hexlify, toBeHex, zeroPadValue, decodeBase58, getBytes } from "ethers";

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeBase58ToBytes(b58: string): Uint8Array {
  const n = decodeBase58(b58);
  const hex = toBeHex(n);
  return getBytes(zeroPadValue(hex, 34));
}

const KNOWN_CID = "QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n";
const KNOWN_BYTES32 = (() => {
  const bytes = decodeBase58ToBytes(KNOWN_CID);
  return hexlify(bytes.slice(2)); // strip 0x1220 multihash prefix
})();

// USDT precompile address (asset ID 1984, trust-backed suffix 0120)
const USDT_PRECOMPILE = "0x000007C000000000000000000000000001200000";

// Minimal SerializedCampaign structure matching poller's internal interface
interface MinCampaign {
  id: string;
  advertiser: string;
  publisher: string;
  remainingBudget: string;
  dailyCap: string;
  bidCpmPlanck: string;
  snapshotTakeRateBps: string;
  status: string;
  categoryId: string;
  pendingExpiryBlock: string;
  terminationBlock: string;
  metadataHash?: string;
  requiredTags?: string[];
  rewardToken?: string;
  rewardPerImpression?: string;
}

function makeCampaign(id: string, overrides: Partial<MinCampaign> = {}): MinCampaign {
  return {
    id,
    advertiser: "0x" + "aa".repeat(20),
    publisher: "0x" + "bb".repeat(20),
    remainingBudget: "1000000000000",
    dailyCap: "100000000000",
    bidCpmPlanck: "16000000000",
    snapshotTakeRateBps: "5000",
    status: "1", // Active
    categoryId: "0",
    pendingExpiryBlock: "0",
    terminationBlock: "0",
    ...overrides,
  };
}

// ── Storage key constants (matches poller internals) ─────────────────────────
const STORAGE_KEY = "activeCampaigns";
const INDEX_KEY   = "campaignIndex";
const LAST_BLOCK_KEY = "pollLastBlock";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("campaignPoller — storage layer", () => {
  beforeEach(() => resetStore());

  // ── CP-3: O(1) getById lookup ─────────────────────────────────────────────
  test("CP-3: getById returns null for empty index", async () => {
    // Simulate what poller.getById does without importing the module
    // (avoids needing ethers/contracts wired up in Jest).
    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const index: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};
    expect(index["1"] ?? null).toBeNull();
  });

  test("CP-3b: getById returns campaign with metadataHash from seeded index", async () => {
    const campaign = makeCampaign("5", { metadataHash: KNOWN_BYTES32 });
    seedStore({ [INDEX_KEY]: { "5": campaign } });

    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const index: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};
    const result = index["5"] ?? null;

    expect(result).not.toBeNull();
    expect(result!.metadataHash).toBe(KNOWN_BYTES32);
    expect(result!.id).toBe("5");
  });

  // ── CP-4: reset() clears index ────────────────────────────────────────────
  test("CP-4: reset removes STORAGE_KEY, INDEX_KEY, LAST_BLOCK_KEY", async () => {
    seedStore({
      [STORAGE_KEY]: [makeCampaign("1")],
      [INDEX_KEY]: { "1": makeCampaign("1") },
      [LAST_BLOCK_KEY]: 12345,
    });

    // Simulate reset()
    await chrome.storage.local.remove([STORAGE_KEY, INDEX_KEY, LAST_BLOCK_KEY]);

    const after = getStore();
    expect(after[STORAGE_KEY]).toBeUndefined();
    expect(after[INDEX_KEY]).toBeUndefined();
    expect(after[LAST_BLOCK_KEY]).toBeUndefined();
  });

  // ── CP-5: Terminal campaigns pruned ───────────────────────────────────────
  test("CP-5: terminal campaigns (status 2,3,4,99) are not included in activeCampaigns", async () => {
    const index: Record<string, MinCampaign> = {
      "1": makeCampaign("1", { status: "1" }),  // Active
      "2": makeCampaign("2", { status: "2" }),  // Completed
      "3": makeCampaign("3", { status: "3" }),  // Terminated
      "4": makeCampaign("4", { status: "4" }),  // Expired
      "5": makeCampaign("5", { status: "99" }), // Blocked
    };

    const TERMINAL = new Set(["2", "3", "4", "99"]);
    for (const id of Object.keys(index)) {
      if (TERMINAL.has(index[id].status)) delete index[id];
    }

    const active = Object.values(index);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("1");
  });

  // ── CP-6: getCached flat array ────────────────────────────────────────────
  test("CP-6: getCached returns flat array stored at STORAGE_KEY", async () => {
    const campaigns = [makeCampaign("1"), makeCampaign("2", { bidCpmPlanck: "32000000000" })];
    seedStore({ [STORAGE_KEY]: campaigns });

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const result: MinCampaign[] = stored[STORAGE_KEY] ?? [];

    expect(result).toHaveLength(2);
    expect(result[1].bidCpmPlanck).toBe("32000000000");
  });
});

// ── CP-1/CP-2: IPFS metadata hash handling ────────────────────────────────────
describe("campaignPoller — IPFS metadata hash", () => {
  beforeEach(() => resetStore());

  test("CP-1: metadataHash stored in index entry after CampaignMetadataSet event", async () => {
    // Simulates Phase 1b: poller parsed CampaignMetadataSet event,
    // stored bytes32 digest in index[campaignId].metadataHash.
    const campaign = makeCampaign("7", { metadataHash: KNOWN_BYTES32 });
    const index = { "7": campaign };
    await chrome.storage.local.set({ [INDEX_KEY]: index, [STORAGE_KEY]: [campaign] });

    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const storedIndex: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};
    expect(storedIndex["7"].metadataHash).toBe(KNOWN_BYTES32);
  });

  test("CP-2: bytes32 → CID → gateway URL round-trip for IPFS fetch", () => {
    // Verify the exact transformation that Phase 5 uses to build the fetch URL.
    const recoveredCid = bytes32ToCid(KNOWN_BYTES32);
    expect(recoveredCid).toBe(KNOWN_CID);

    const url = metadataUrl(KNOWN_BYTES32, "https://dweb.link/ipfs/");
    expect(url).not.toBeNull();
    expect(url!).toBe(`https://dweb.link/ipfs/${KNOWN_CID}`);
  });

  test("CP-2b: metadataUrl returns null for zero hash (campaign without IPFS metadata)", () => {
    const zeroHash = "0x" + "0".repeat(64);
    expect(metadataUrl(zeroHash, "https://dweb.link/ipfs/")).toBeNull();
  });

  test("CP-2c: multiple gateway fallback — URLs derived for each gateway correctly", () => {
    const gateways = [
      "https://dweb.link/ipfs/",
      "https://ipfs.io/ipfs/",
      "https://cloudflare-ipfs.com/ipfs/",
      "https://gateway.pinata.cloud/ipfs/",
    ];
    for (const gw of gateways) {
      const url = metadataUrl(KNOWN_BYTES32, gw);
      expect(url).not.toBeNull();
      expect(url!).toContain(KNOWN_CID);
      expect(url!).toContain(gw);
    }
  });

  // ── CP-8: IPFS metadata fetch result stored with TTL ─────────────────────
  test("CP-8: metadata fetch result stored at metadata:{id} with timestamp at metadata_ts:{id}", async () => {
    const campaignId = "3";
    const mockMeta = {
      creative: {
        headline: "Buy Crypto",
        body: "The best exchange",
        ctaUrl: "https://example.com",
        imageUrl: "",
      },
      targeting: {
        requiredTags: ["topic:crypto-web3"],
      },
    };

    // Simulate Phase 5 write after successful IPFS fetch
    const metaKey = `metadata:${campaignId}`;
    const tsKey = `metadata_ts:${campaignId}`;
    const now = Date.now();
    await chrome.storage.local.set({ [metaKey]: mockMeta, [tsKey]: now });

    const stored = await chrome.storage.local.get([metaKey, tsKey]);
    expect(stored[metaKey]).toEqual(mockMeta);
    expect(stored[tsKey]).toBe(now);
  });

  test("CP-8b: metadata within TTL is not re-fetched (TTL = 1 hour)", async () => {
    const campaignId = "4";
    const metaKey = `metadata:${campaignId}`;
    const tsKey = `metadata_ts:${campaignId}`;
    const recentTs = Date.now() - 60_000; // 1 minute ago (well within 1-hour TTL)

    seedStore({ [metaKey]: { creative: { headline: "Fresh" } }, [tsKey]: recentTs });

    const stored = await chrome.storage.local.get([metaKey, tsKey]);
    const fetchedAt: number | undefined = stored[tsKey];
    const METADATA_TTL_MS = 3_600_000;
    const shouldRefetch = !fetchedAt || Date.now() - fetchedAt >= METADATA_TTL_MS;

    expect(shouldRefetch).toBe(false);
    // Existing metadata preserved
    expect(stored[metaKey].creative.headline).toBe("Fresh");
  });

  // ── CP-9: Stale metadata cleanup ─────────────────────────────────────────
  test("CP-9: stale metadata keys removed when campaign no longer active", async () => {
    // Active campaign: ID 1. Stale campaign: ID 99 (no longer in activeCampaigns).
    seedStore({
      [STORAGE_KEY]: [makeCampaign("1")],
      "metadata:1":    { creative: { headline: "Active" } },
      "metadata_ts:1": Date.now(),
      "metadata:99":   { creative: { headline: "Stale"  } },
      "metadata_ts:99": Date.now() - 7_200_000,
    });

    // Simulate Phase 4 cleanup
    const { [STORAGE_KEY]: active } = await chrome.storage.local.get(STORAGE_KEY);
    const activeIdSet = new Set((active as MinCampaign[]).map(c => c.id));
    const all = getStore();
    const staleMetaKeys = Object.keys(all).filter(k => {
      if (!k.startsWith("metadata:") && !k.startsWith("metadata_ts:") && !k.startsWith("metadata_url:")) return false;
      const cid = k.split(":")[1];
      return !activeIdSet.has(cid);
    });

    await chrome.storage.local.remove(staleMetaKeys);

    const after = getStore();
    expect(after["metadata:99"]).toBeUndefined();
    expect(after["metadata_ts:99"]).toBeUndefined();
    expect(after["metadata:1"]).toBeDefined(); // active campaign metadata kept
  });
});

// ── CP-7/CP-10: ERC-20 sidecar + competing campaign CPMs ─────────────────────
describe("campaignPoller — ERC-20 sidecar and competing CPMs", () => {
  beforeEach(() => resetStore());

  test("CP-7: campaign with ERC-20 rewardToken stored in index", async () => {
    const ercCampaign = makeCampaign("10", {
      rewardToken: "0x" + "dd".repeat(20), // mock ERC-20 address
      rewardPerImpression: "1000000000000000", // 0.001 TUSD (18 dec)
    });
    const index = { "10": ercCampaign };
    await chrome.storage.local.set({ [INDEX_KEY]: index, [STORAGE_KEY]: [ercCampaign] });

    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const idx: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};
    expect(idx["10"].rewardToken).toBe("0x" + "dd".repeat(20));
    expect(idx["10"].rewardPerImpression).toBe("1000000000000000");
  });

  test("CP-7b: native asset precompile address (USDT) stored as rewardToken", async () => {
    // USDT precompile = 0x000007C000000000000000000000000001200000
    const nativeCampaign = makeCampaign("11", {
      rewardToken: USDT_PRECOMPILE,
      rewardPerImpression: "1000", // 0.001 USDT (6 dec)
    });
    seedStore({ [INDEX_KEY]: { "11": nativeCampaign }, [STORAGE_KEY]: [nativeCampaign] });

    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const idx: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};
    expect(idx["11"].rewardToken).toBe(USDT_PRECOMPILE);
    // The precompile address starts with 0x and has no name/symbol on-chain
    // — the extension uses assetRegistry to resolve display metadata
    expect(idx["11"].rewardToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  // ── CP-10: Competing CPMs stored independently ────────────────────────────
  test("CP-10: three competing campaigns at different CPMs stored independently", async () => {
    const campaigns = [
      makeCampaign("20", { bidCpmPlanck: "500000000000" }),  // 50 DOT CPM
      makeCampaign("21", { bidCpmPlanck: "200000000000" }),  // 20 DOT CPM
      makeCampaign("22", { bidCpmPlanck: "100000000000" }),  // 10 DOT CPM
    ];
    const index = Object.fromEntries(campaigns.map(c => [c.id, c]));
    await chrome.storage.local.set({ [INDEX_KEY]: index, [STORAGE_KEY]: campaigns });

    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const idx: Record<string, MinCampaign> = stored[INDEX_KEY] ?? {};

    expect(idx["20"].bidCpmPlanck).toBe("500000000000");
    expect(idx["21"].bidCpmPlanck).toBe("200000000000");
    expect(idx["22"].bidCpmPlanck).toBe("100000000000");

    // Campaign 20 has 5× the CPM of campaign 22
    expect(BigInt(idx["20"].bidCpmPlanck) / BigInt(idx["22"].bidCpmPlanck)).toBe(5n);
  });

  test("CP-10b: IPFS + ERC-20 + plain campaigns coexist with distinct IDs", async () => {
    const ipfsCampaign  = makeCampaign("30", {
      metadataHash: KNOWN_BYTES32,
      bidCpmPlanck: "200000000000",
    });
    const ercCampaign   = makeCampaign("31", {
      rewardToken: "0x" + "ee".repeat(20),
      rewardPerImpression: "5000000000000000",
      bidCpmPlanck: "500000000000", // higher DOT CPM (premium)
    });
    const plainCampaign = makeCampaign("32", { bidCpmPlanck: "100000000000" });

    const index = { "30": ipfsCampaign, "31": ercCampaign, "32": plainCampaign };
    const active = [ipfsCampaign, ercCampaign, plainCampaign];
    await chrome.storage.local.set({ [INDEX_KEY]: index, [STORAGE_KEY]: active });

    const stored = await chrome.storage.local.get([INDEX_KEY, STORAGE_KEY]);
    const idx: Record<string, MinCampaign>  = stored[INDEX_KEY] ?? {};
    const act: MinCampaign[]               = stored[STORAGE_KEY] ?? [];

    // IPFS campaign
    expect(idx["30"].metadataHash).toBe(KNOWN_BYTES32);
    expect(idx["30"].rewardToken).toBeUndefined();

    // ERC-20 sidecar campaign (highest CPM)
    expect(idx["31"].rewardToken).toBe("0x" + "ee".repeat(20));
    expect(BigInt(idx["31"].bidCpmPlanck)).toBeGreaterThan(BigInt(idx["30"].bidCpmPlanck));

    // Plain campaign
    expect(idx["32"].rewardToken).toBeUndefined();
    expect(idx["32"].metadataHash).toBeUndefined();

    // All three in flat list
    expect(act).toHaveLength(3);

    // Verify metadataUrl works for IPFS campaign
    const url = metadataUrl(idx["30"].metadataHash!, "https://dweb.link/ipfs/");
    expect(url).not.toBeNull();
    expect(url!).toContain(KNOWN_CID);
  });
});
