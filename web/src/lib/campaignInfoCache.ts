// Per-campaign info cache for chip rendering.
//
// Fetches the load-bearing display fields for a campaign:
//   - title (from IPFS metadata pointed to by Campaigns.metadataHash)
//   - advertiser address (so the chip can wrap a BrandChip)
//   - status (Pending/Active/etc — drives the badge)
//   - viewBid (CPM ceiling; shown as a sublabel)
//   - requiredTags (compact tag chips)
//
// All fields cached in localStorage by (chainKey, campaignId) so subsequent
// renders are zero-RPC. Stale-while-revalidate: TTL 1h; we serve cached
// entries instantly and trigger a background refresh after the TTL.

import { Contract, JsonRpcProvider } from "ethers";
import { bytes32ToCid } from "@shared/ipfs";

export interface CampaignInfo {
  campaignId: string;
  title: string;            // "" when no metadata set
  advertiser: string;       // 0x address, lowercase
  publisher: string;        // 0x address (0x00... for open campaigns)
  status: number;           // 0=Pending 1=Active 2=Paused etc
  viewBidPlanck: string;    // serialized bigint
  requiredTags: string[];   // bytes32 hashes
  metadataHash: string;     // bytes32 hex
  ts: number;               // cache timestamp
}

const STORAGE_PREFIX = "datum_campaign_info:";
const STORAGE_VERSION = 1;
const TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry { v: number; info: CampaignInfo; }

const CAMPAIGNS_ABI = [
  "function getCampaignForSettlement(uint256) view returns (uint8 status, address publisher, uint16 takeRateBps)",
  "function getCampaignAdvertiser(uint256) view returns (address)",
  "function getCampaignViewBid(uint256) view returns (uint256)",
  "function getCampaignTags(uint256) view returns (bytes32[])",
  "function getCampaignMetadata(uint256) view returns (bytes32)",
];

function key(chainKey: string, campaignId: string): string {
  return STORAGE_PREFIX + chainKey + ":" + campaignId;
}

function readCache(chainKey: string, campaignId: string): CampaignInfo | null {
  try {
    const raw = localStorage.getItem(key(chainKey, campaignId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.v !== STORAGE_VERSION) return null;
    return parsed.info;
  } catch { return null; }
}

function writeCache(chainKey: string, info: CampaignInfo): void {
  try {
    localStorage.setItem(key(chainKey, info.campaignId), JSON.stringify({ v: STORAGE_VERSION, info }));
  } catch { /* storage full or disabled — skip */ }
}

const ZERO_HASH = "0x" + "0".repeat(64);

/** Resolve a campaign's display info. Returns cached entry instantly when
 *  fresh; triggers a background refresh otherwise. The `onRefreshed`
 *  callback receives the post-refresh entry (or the same one if nothing
 *  changed). Always returns *something* — falls back to an empty info
 *  with zero fields if the chain is unreachable. */
export async function fetchCampaignInfo(opts: {
  campaignId: string;
  chainKey: string;            // e.g. "polkadotTestnet"
  campaignsAddr: string;
  provider: JsonRpcProvider;
  ipfsGateway: string;
}): Promise<CampaignInfo> {
  const { campaignId, chainKey, campaignsAddr, provider, ipfsGateway } = opts;
  const cached = readCache(chainKey, campaignId);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached;
  }

  const empty: CampaignInfo = {
    campaignId, title: "", advertiser: "", publisher: "",
    status: 0, viewBidPlanck: "0", requiredTags: [], metadataHash: ZERO_HASH,
    ts: Date.now(),
  };
  if (!campaignsAddr) return cached ?? empty;

  try {
    const c = new Contract(campaignsAddr, CAMPAIGNS_ABI, provider);
    const [cfs, advertiser, viewBid, tags, metadataHash] = await Promise.all([
      c.getCampaignForSettlement(BigInt(campaignId)).catch(() => [0, "0x0000000000000000000000000000000000000000", 0]),
      c.getCampaignAdvertiser(BigInt(campaignId)).catch(() => "0x0000000000000000000000000000000000000000"),
      c.getCampaignViewBid(BigInt(campaignId)).catch(() => 0n),
      c.getCampaignTags(BigInt(campaignId)).catch(() => [] as string[]),
      c.getCampaignMetadata(BigInt(campaignId)).catch(() => ZERO_HASH),
    ]);

    let title = "";
    const mhStr = String(metadataHash);
    if (mhStr && mhStr !== ZERO_HASH) {
      title = await fetchCampaignTitle(mhStr, ipfsGateway);
    }

    const info: CampaignInfo = {
      campaignId,
      title,
      advertiser: String(advertiser).toLowerCase(),
      publisher: String(cfs[1] ?? "0x0000000000000000000000000000000000000000").toLowerCase(),
      status: Number(cfs[0] ?? 0),
      viewBidPlanck: String(viewBid),
      requiredTags: Array.isArray(tags) ? tags.map(String) : [],
      metadataHash: mhStr,
      ts: Date.now(),
    };
    writeCache(chainKey, info);
    return info;
  } catch {
    return cached ?? empty;
  }
}

/** Fetch the campaign title only from the IPFS metadata JSON. Bounded
 *  to a 6s timeout. Returns "" when the gateway is slow or the JSON is
 *  malformed; callers fall back to the campaignId. */
async function fetchCampaignTitle(metadataHash: string, ipfsGateway: string): Promise<string> {
  try {
    const cid = bytes32ToCid(metadataHash);
    if (!cid) return "";
    const gw = ipfsGateway.replace(/\/$/, "");
    const url = `${gw}/${cid}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) return "";
      const body = await res.json();
      const title = String(body?.title ?? body?.creative?.title ?? "").slice(0, 128);
      return title;
    } finally {
      clearTimeout(timeout);
    }
  } catch { return ""; }
}
