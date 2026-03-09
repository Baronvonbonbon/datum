// Polls DatumCampaigns for campaigns and caches them in storage.
// A1.3: uses slim getters (getCampaignStatus, getCampaignAdvertiser, getCampaignRemainingBudget)
// instead of getCampaign() which was removed.

import { JsonRpcProvider } from "ethers";
import { getCampaignsContract } from "@shared/contracts";
import { metadataUrl } from "@shared/ipfs";
import { Campaign, CampaignMetadata, CampaignStatus, ContractAddresses } from "@shared/types";
import { validateAndSanitize, MAX_METADATA_BYTES } from "@shared/contentSafety";

const STORAGE_KEY = "activeCampaigns";
const MAX_SCAN_ID = 1000;
const METADATA_TTL_MS = 3600_000; // 1 hour cache TTL for IPFS metadata

export const campaignPoller = {
  async poll(rpcUrl: string, addresses: ContractAddresses, ipfsGateway?: string): Promise<void> {
    try {
      if (!addresses.campaigns || !addresses.campaigns.startsWith("0x")) {
        console.warn("[DATUM] Skipping poll — no valid campaigns contract address");
        return;
      }
      const provider = new JsonRpcProvider(rpcUrl);
      const campaigns: SerializedCampaign[] = [];
      const contract = getCampaignsContract(addresses, provider);

      // Get next campaign ID to know scan range
      let nextId: number;
      try {
        nextId = Number(await contract.nextCampaignId());
      } catch {
        // Fallback: scan until misses
        nextId = MAX_SCAN_ID;
      }

      // Discover campaigns using A1.3 slim getters
      let missCount = 0;
      for (let id = 0; id < Math.min(nextId, MAX_SCAN_ID); id++) {
        try {
          const status = Number(await contract.getCampaignStatus(BigInt(id)));
          // Include Active, Pending, Paused for full visibility
          if (status === CampaignStatus.Active || status === CampaignStatus.Pending || status === CampaignStatus.Paused) {
            const [advertiser, remaining] = await Promise.all([
              contract.getCampaignAdvertiser(BigInt(id)),
              contract.getCampaignRemainingBudget(BigInt(id)),
            ]);

            // Read bidCpmPlanck and other fields from campaigns mapping
            const cData = await contract.campaigns(BigInt(id));

            campaigns.push({
              id: id.toString(),
              advertiser,
              publisher: cData.publisher ?? "",
              remainingBudget: BigInt(remaining).toString(),
              dailyCap: BigInt(cData.dailyCapPlanck ?? cData.dailyCap ?? 0n).toString(),
              bidCpmPlanck: BigInt(cData.bidCpmPlanck ?? 0n).toString(),
              snapshotTakeRateBps: Number(cData.snapshotTakeRateBps ?? 0).toString(),
              status: status.toString(),
              categoryId: Number(cData.categoryId ?? 0).toString(),
              pendingExpiryBlock: BigInt(cData.pendingExpiryBlock ?? 0n).toString(),
              terminationBlock: BigInt(cData.terminationBlock ?? 0n).toString(),
            });
            missCount = 0;
          } else {
            // Non-active status — still valid campaign, reset miss counter
            missCount = 0;
          }
        } catch {
          missCount++;
          if (missCount >= 3) break;
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: campaigns });
      console.log(`[DATUM] Polled ${campaigns.length} campaigns (Active/Pending/Paused)`);

      // Fetch IPFS metadata for campaigns
      const gateway = ipfsGateway || "https://dweb.link/ipfs/";
      for (const c of campaigns) {
        const metaKey = `metadata:${c.id}`;
        const tsKey = `metadata_ts:${c.id}`;
        const existing = await chrome.storage.local.get([metaKey, tsKey]);
        if (existing[metaKey]) {
          const fetchedAt = existing[tsKey] as number | undefined;
          if (fetchedAt && Date.now() - fetchedAt < METADATA_TTL_MS) continue;
        }

        try {
          const filter = contract.filters.CampaignMetadataSet(BigInt(c.id));
          const events = await contract.queryFilter(filter);
          if (events.length === 0) continue;

          const lastEvent = events[events.length - 1];
          const hash: string = (lastEvent as any).args?.[1] ?? (lastEvent as any).args?.metadataHash;
          if (!hash) continue;

          const url = metadataUrl(hash, gateway);
          if (!url) continue;

          const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (resp.ok) {
            // Size cap: check Content-Length header first, then body length
            const contentLength = resp.headers.get("content-length");
            if (contentLength && parseInt(contentLength, 10) > MAX_METADATA_BYTES) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} exceeds ${MAX_METADATA_BYTES}B (Content-Length: ${contentLength}), skipping`);
              continue;
            }

            const bodyText = await resp.text();
            if (bodyText.length > MAX_METADATA_BYTES) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} exceeds ${MAX_METADATA_BYTES}B (body: ${bodyText.length}), skipping`);
              continue;
            }

            const rawMeta = JSON.parse(bodyText);
            const meta = validateAndSanitize(rawMeta);
            if (!meta) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} failed validation, skipping`);
              continue;
            }

            await chrome.storage.local.set({ [metaKey]: meta, [tsKey]: Date.now() });
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

  async getCached(): Promise<SerializedCampaign[]> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? [];
  },

  /** Return serialized (string) form for chrome.runtime.sendMessage (BigInt not JSON-safe). */
  async getCachedSerialized(): Promise<Record<string, string>[]> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? [];
  },
};

// All fields stored as strings (already serialized from BigInt)
interface SerializedCampaign {
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
}
