// Polls DatumCampaigns for Active campaigns and caches them in storage.

import { JsonRpcProvider } from "ethers";
import { getCampaignsContract, getPublishersContract } from "@shared/contracts";
import { Campaign, CampaignStatus, ContractAddresses } from "@shared/types";

const STORAGE_KEY = "activeCampaigns";
const MAX_SCAN_ID = 1000; // scan campaign IDs 1..N until two consecutive misses

export const campaignPoller = {
  async poll(rpcUrl: string, addresses: ContractAddresses): Promise<void> {
    try {
      const provider = new JsonRpcProvider(rpcUrl);
      const campaigns: Campaign[] = [];
      const contract = getCampaignsContract(addresses, provider);

      // Discover campaigns by scanning IDs from 1 until consecutive misses
      let missCount = 0;
      for (let id = 1; id <= MAX_SCAN_ID; id++) {
        try {
          const c = await contract.getCampaign(BigInt(id));
          if (c.id === 0n) {
            missCount++;
            if (missCount >= 3) break; // 3 consecutive misses = end of campaigns
            continue;
          }
          missCount = 0;
          if (c.status === CampaignStatus.Active) {
            campaigns.push(normalizeCampaign(c));
          }
        } catch {
          missCount++;
          if (missCount >= 3) break;
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: serializeCampaigns(campaigns) });
      console.log(`[DATUM] Polled ${campaigns.length} active campaigns`);
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
};

// Campaign structs contain bigint — serialize to strings for chrome.storage.local (JSON)
function normalizeCampaign(raw: {
  id: bigint;
  advertiser: string;
  publisher: string;
  budget: bigint;
  remainingBudget: bigint;
  dailyCap: bigint;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: bigint;
  status: bigint;
  pendingExpiryBlock: bigint;
  terminationBlock: bigint;
}): Campaign {
  return {
    id: raw.id,
    advertiser: raw.advertiser,
    publisher: raw.publisher,
    budget: raw.budget,
    remainingBudget: raw.remainingBudget,
    dailyCap: raw.dailyCap,
    bidCpmPlanck: raw.bidCpmPlanck,
    snapshotTakeRateBps: Number(raw.snapshotTakeRateBps),
    status: Number(raw.status),
    pendingExpiryBlock: raw.pendingExpiryBlock,
    terminationBlock: raw.terminationBlock,
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
    pendingExpiryBlock: BigInt(c.pendingExpiryBlock),
    terminationBlock: BigInt(c.terminationBlock),
  }));
}
