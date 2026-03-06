// Polls DatumCampaigns for Active campaigns and caches them in storage.
// Also fetches IPFS metadata for campaigns that have CampaignMetadataSet events.

import { JsonRpcProvider } from "ethers";
import { getCampaignsContract } from "@shared/contracts";
import { metadataUrl } from "@shared/ipfs";
import { Campaign, CampaignMetadata, CampaignStatus, ContractAddresses } from "@shared/types";

const STORAGE_KEY = "activeCampaigns";
const MAX_SCAN_ID = 1000; // scan campaign IDs 1..N until two consecutive misses

export const campaignPoller = {
  async poll(rpcUrl: string, addresses: ContractAddresses, ipfsGateway?: string): Promise<void> {
    try {
      if (!addresses.campaigns || !addresses.campaigns.startsWith("0x")) {
        console.warn("[DATUM] Skipping poll — no valid campaigns contract address");
        return;
      }
      const provider = new JsonRpcProvider(rpcUrl);
      const campaigns: Campaign[] = [];
      const contract = getCampaignsContract(addresses, provider);

      // Discover campaigns by scanning IDs from 1 until consecutive misses
      let missCount = 0;
      for (let id = 1; id <= MAX_SCAN_ID; id++) {
        try {
          const c = await contract.getCampaign(BigInt(id));
          // ethers v6 returns Result object — id is field 0 (uint256)
          const cId = BigInt(c.id ?? c[0] ?? 0n);
          if (cId === 0n) {
            missCount++;
            if (missCount >= 3) break;
            continue;
          }
          missCount = 0;
          const cStatus = Number(c.status ?? c[12] ?? 0);
          if (cStatus === CampaignStatus.Active) {
            campaigns.push(normalizeCampaign(c));
          }
        } catch {
          missCount++;
          if (missCount >= 3) break;
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: serializeCampaigns(campaigns) });
      console.log(`[DATUM] Polled ${campaigns.length} active campaigns`);

      // Fetch IPFS metadata for campaigns that don't have cached metadata
      const gateway = ipfsGateway || "https://dweb.link/ipfs/";
      for (const c of campaigns) {
        const metaKey = `metadata:${c.id.toString()}`;
        const existing = await chrome.storage.local.get(metaKey);
        if (existing[metaKey]) continue; // already cached

        try {
          // Query CampaignMetadataSet events for this campaign
          const filter = contract.filters.CampaignMetadataSet(c.id);
          const events = await contract.queryFilter(filter);
          if (events.length === 0) continue;

          const lastEvent = events[events.length - 1];
          const hash: string = (lastEvent as any).args?.[1] ?? (lastEvent as any).args?.metadataHash;
          if (!hash) continue;

          // Decode bytes32 → CID → gateway URL
          const url = metadataUrl(hash, gateway);
          if (!url) continue;

          const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (resp.ok) {
            const meta: CampaignMetadata = await resp.json();
            await chrome.storage.local.set({ [metaKey]: meta });
            console.log(`[DATUM] Cached metadata for campaign ${c.id}`);
          }
        } catch (err) {
          console.warn(`[DATUM] Failed to fetch metadata for campaign ${c.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[DATUM] campaignPoller.poll failed:", err);
    }
  },

  async getCached(): Promise<Campaign[]> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY];
    if (!raw) return [];
    return deserializeCampaigns(raw);
  },

  /** Return serialized (string) form for chrome.runtime.sendMessage (BigInt not JSON-safe). */
  async getCachedSerialized(): Promise<Record<string, string>[]> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? [];
  },
};

// Campaign structs contain bigint — serialize to strings for chrome.storage.local (JSON)
// ethers v6 returns struct fields by their ABI names.
// The Solidity Campaign struct uses budgetPlanck/dailyCapPlanck, not budget/dailyCap.
// We accept both for safety (positional access works regardless).
function normalizeCampaign(raw: any): Campaign {
  return {
    id: BigInt(raw.id),
    advertiser: raw.advertiser,
    publisher: raw.publisher,
    budget: BigInt(raw.budgetPlanck ?? raw.budget ?? raw[3] ?? 0n),
    remainingBudget: BigInt(raw.remainingBudget ?? raw[4] ?? 0n),
    dailyCap: BigInt(raw.dailyCapPlanck ?? raw.dailyCap ?? raw[5] ?? 0n),
    bidCpmPlanck: BigInt(raw.bidCpmPlanck ?? raw[6] ?? 0n),
    snapshotTakeRateBps: Number(raw.snapshotTakeRateBps ?? raw[11] ?? 0),
    status: Number(raw.status ?? raw[12] ?? 0),
    categoryId: Number(raw.categoryId ?? raw[13] ?? 0),
    pendingExpiryBlock: BigInt(raw.pendingExpiryBlock ?? raw[9] ?? 0n),
    terminationBlock: BigInt(raw.terminationBlock ?? raw[10] ?? 0n),
  };
}

function serializeCampaigns(campaigns: Campaign[]): Record<string, string>[] {
  return campaigns.map((c) =>
    Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)])
    )
  );
}

function deserializeCampaigns(raw: Record<string, string>[]): Campaign[] {
  return raw.map((c) => ({
    id: BigInt(c.id),
    advertiser: c.advertiser,
    publisher: c.publisher,
    budget: BigInt(c.budget),
    remainingBudget: BigInt(c.remainingBudget),
    dailyCap: BigInt(c.dailyCap),
    bidCpmPlanck: BigInt(c.bidCpmPlanck),
    snapshotTakeRateBps: Number(c.snapshotTakeRateBps),
    status: Number(c.status) as CampaignStatus,
    categoryId: Number(c.categoryId ?? 0),
    pendingExpiryBlock: BigInt(c.pendingExpiryBlock),
    terminationBlock: BigInt(c.terminationBlock),
  }));
}
