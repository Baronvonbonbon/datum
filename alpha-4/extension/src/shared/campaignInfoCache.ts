// Per-campaign display-info cache for the extension. Mirrors
// web/src/lib/campaignInfoCache.ts but uses chrome.storage.local instead
// of localStorage, and prefers the existing activeCampaigns cache for hot
// reads to avoid burning RPC on each popup open.

import { Contract, JsonRpcProvider } from "ethers";
import { bytes32ToCid } from "@shared/ipfs";

export interface CampaignDisplayInfo {
  campaignId: string;
  title: string;
  advertiser: string;
  publisher: string;
  status: number;
  viewBidPlanck: string;
  metadataHash: string;
  ts: number;
}

const STORAGE_PREFIX = "campaign_info:";
const STORAGE_VERSION = 1;
const TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry { v: number; info: CampaignDisplayInfo; }

const CAMPAIGNS_ABI = [
  "function getCampaignForSettlement(uint256) view returns (uint8 status, address publisher, uint16 takeRateBps)",
  "function getCampaignAdvertiser(uint256) view returns (address)",
  "function getCampaignViewBid(uint256) view returns (uint256)",
  "function getCampaignMetadata(uint256) view returns (bytes32)",
];

const ZERO_HASH = "0x" + "0".repeat(64);

function key(chainKey: string, campaignId: string): string {
  return STORAGE_PREFIX + chainKey + ":" + campaignId;
}

async function readCache(chainKey: string, campaignId: string): Promise<CampaignDisplayInfo | null> {
  try {
    const k = key(chainKey, campaignId);
    const stored = await chrome.storage.local.get(k);
    const parsed = (stored as any)[k] as CacheEntry | undefined;
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    return parsed.info;
  } catch { return null; }
}

async function writeCache(chainKey: string, info: CampaignDisplayInfo): Promise<void> {
  try {
    await chrome.storage.local.set({ [key(chainKey, info.campaignId)]: { v: STORAGE_VERSION, info } });
  } catch { /* storage full or disabled */ }
}

async function readActiveCampaign(campaignId: string): Promise<any | null> {
  try {
    const stored = await chrome.storage.local.get("activeCampaigns");
    const list = (stored as any).activeCampaigns as any[] | undefined;
    if (!Array.isArray(list)) return null;
    return list.find((c) => String(c.id) === campaignId) ?? null;
  } catch { return null; }
}

async function fetchTitle(metadataHash: string, ipfsGateway: string): Promise<string> {
  try {
    if (!metadataHash || metadataHash === ZERO_HASH) return "";
    const cid = bytes32ToCid(metadataHash);
    if (!cid) return "";
    const gw = ipfsGateway.replace(/\/$/, "");
    const url = `${gw}/${cid}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) return "";
      const body = await res.json();
      const title = String(body?.title ?? body?.creative?.title ?? "").slice(0, 128);
      return title;
    } finally {
      clearTimeout(t);
    }
  } catch { return ""; }
}

/** Resolve a campaign's display fields. Stale-while-revalidate: returns
 *  cached entry instantly when fresh. When the only available info is
 *  what's in activeCampaigns (no title yet), synthesizes a partial info
 *  and triggers an async metadata fetch in the background. */
export async function fetchCampaignDisplay(opts: {
  campaignId: string;
  chainKey: string;
  campaignsAddr: string | null | undefined;
  rpcUrl: string;
  ipfsGateway: string;
}): Promise<CampaignDisplayInfo> {
  const { campaignId, chainKey, campaignsAddr, rpcUrl, ipfsGateway } = opts;
  const empty: CampaignDisplayInfo = {
    campaignId, title: "", advertiser: "", publisher: "",
    status: 0, viewBidPlanck: "0", metadataHash: ZERO_HASH, ts: Date.now(),
  };

  const cached = await readCache(chainKey, campaignId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached;

  // Try the activeCampaigns chrome.storage cache first — cheap, in-process.
  const active = await readActiveCampaign(campaignId);
  let synthesized: CampaignDisplayInfo | null = null;
  if (active) {
    synthesized = {
      campaignId,
      title: "", // not in active cache yet
      advertiser: String(active.advertiser ?? "").toLowerCase(),
      publisher: String(active.publisher ?? "").toLowerCase(),
      status: Number(active.status ?? 0),
      viewBidPlanck: String(active.viewBid ?? "0"),
      metadataHash: String(active.metadataHash ?? ZERO_HASH),
      ts: Date.now(),
    };
  }

  if (!campaignsAddr) {
    if (synthesized) {
      // Try to fetch the title even if we couldn't reach the chain for the
      // other fields.
      if (synthesized.metadataHash !== ZERO_HASH) {
        synthesized.title = await fetchTitle(synthesized.metadataHash, ipfsGateway);
        await writeCache(chainKey, synthesized);
      }
      return synthesized;
    }
    return cached ?? empty;
  }

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const c = new Contract(campaignsAddr, CAMPAIGNS_ABI, provider);
    const [cfs, advertiser, viewBid, metadataHash] = await Promise.all([
      c.getCampaignForSettlement(BigInt(campaignId)).catch(() => [0, "0x0000000000000000000000000000000000000000", 0]),
      c.getCampaignAdvertiser(BigInt(campaignId)).catch(() => "0x0000000000000000000000000000000000000000"),
      c.getCampaignViewBid(BigInt(campaignId)).catch(() => 0n),
      c.getCampaignMetadata(BigInt(campaignId)).catch(() => ZERO_HASH),
    ]);
    const mh = String(metadataHash);
    const title = mh !== ZERO_HASH ? await fetchTitle(mh, ipfsGateway) : "";
    const info: CampaignDisplayInfo = {
      campaignId,
      title,
      advertiser: String(advertiser).toLowerCase(),
      publisher: String(cfs[1] ?? "0x0000000000000000000000000000000000000000").toLowerCase(),
      status: Number(cfs[0] ?? 0),
      viewBidPlanck: String(viewBid),
      metadataHash: mh,
      ts: Date.now(),
    };
    await writeCache(chainKey, info);
    return info;
  } catch {
    return synthesized ?? cached ?? empty;
  }
}
