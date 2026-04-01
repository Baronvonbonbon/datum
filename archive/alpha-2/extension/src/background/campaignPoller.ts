// Polls DatumCampaigns for campaigns and caches them in storage.
// Alpha-2: uses slim getters (getCampaignStatus, getCampaignAdvertiser) on Campaigns,
// getRemainingBudget on BudgetLedger, getCampaignForSettlement returns 4 values (no remainingBudget).

import { JsonRpcProvider } from "ethers";
import { getCampaignsContract, getBudgetLedgerContract } from "@shared/contracts";
import { metadataUrl } from "@shared/ipfs";
import { Campaign, CampaignMetadata, CampaignStatus, ContractAddresses } from "@shared/types";
import { validateAndSanitize, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { isUrlPhishing, isAddressBlocked, refreshPhishingList } from "@shared/phishingList";

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

      // Refresh phishing deny list if stale (>6h)
      await refreshPhishingList();

      const provider = new JsonRpcProvider(rpcUrl);
      const campaigns: SerializedCampaign[] = [];
      const contract = getCampaignsContract(addresses, provider);
      const ledger = addresses.budgetLedger
        ? getBudgetLedgerContract(addresses, provider) : null;

      // Get next campaign ID to know scan range
      let nextId: number;
      try {
        nextId = Number(await contract.nextCampaignId());
      } catch {
        // Fallback: scan until misses
        nextId = MAX_SCAN_ID;
      }

      // Discover campaigns using slim getters
      // Alpha-2: getCampaignForSettlement returns 4 values (status, publisher, bidCpmPlanck, snapshotTakeRateBps)
      // remainingBudget from BudgetLedger; categoryId/dailyCap from events
      let missCount = 0;
      for (let id = 1; id < Math.min(nextId, MAX_SCAN_ID); id++) {
        try {
          const [status, advertiser] = await Promise.all([
            contract.getCampaignStatus(BigInt(id)).then(Number),
            contract.getCampaignAdvertiser(BigInt(id)),
          ]);
          // Include Active, Pending, Paused for full visibility
          if (status === CampaignStatus.Active || status === CampaignStatus.Pending || status === CampaignStatus.Paused) {
            // Skip campaigns from blocked advertisers
            if (await isAddressBlocked(advertiser)) {
              console.warn(`[DATUM] Campaign ${id} advertiser flagged: ${advertiser}`);
              missCount = 0;
              continue;
            }

            // Alpha-2: getCampaignForSettlement returns 4 values (no remainingBudget)
            // (status, publisher, bidCpmPlanck, snapshotTakeRateBps)
            const settlementData = await contract.getCampaignForSettlement(BigInt(id));
            const remaining = ledger
              ? await ledger.getRemainingBudget(BigInt(id)).catch(() => 0n) : 0n;

            campaigns.push({
              id: id.toString(),
              advertiser,
              publisher: settlementData[1] ?? "",
              remainingBudget: BigInt(remaining).toString(),
              dailyCap: "0", // not exposed by slim getters
              bidCpmPlanck: BigInt(settlementData[2]).toString(),
              snapshotTakeRateBps: Number(settlementData[3]).toString(),
              status: status.toString(),
              categoryId: "0", // not exposed by slim getters
              pendingExpiryBlock: "0",
              terminationBlock: "0",
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

      // Enrich with categoryId from CampaignCreated events (only exposed via events)
      if (campaigns.length > 0) {
        try {
          const filter = contract.filters.CampaignCreated();
          const events = await contract.queryFilter(filter);
          for (const ev of events) {
            const args = (ev as any).args;
            if (!args) continue;
            const cid = args[0]?.toString() ?? args.campaignId?.toString();
            const cat = Number(args[7] ?? args.categoryId ?? 0);
            const dailyCap = BigInt(args[4] ?? args.dailyCapPlanck ?? 0);
            const camp = campaigns.find((c) => c.id === cid);
            if (camp) {
              camp.categoryId = cat.toString();
              camp.dailyCap = dailyCap.toString();
            }
          }
        } catch (err) {
          console.warn("[DATUM] Could not enrich campaign categories from events:", err);
        }
      }

      // Enrich with metadataHash from CampaignMetadataSet events
      if (campaigns.length > 0) {
        try {
          const metaFilter = contract.filters.CampaignMetadataSet();
          const metaEvents = await contract.queryFilter(metaFilter);
          for (const ev of metaEvents) {
            const args = (ev as any).args;
            if (!args) continue;
            const cid = (args[0] ?? args.campaignId)?.toString();
            const hash: string = args[1] ?? args.metadataHash ?? "";
            if (!cid || !hash) continue;
            const camp = campaigns.find((c) => c.id === cid);
            if (camp) camp.metadataHash = hash;
          }
        } catch (err) {
          console.warn("[DATUM] Could not enrich metadata hashes from events:", err);
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: campaigns });
      console.log(`[DATUM] Polled ${campaigns.length} campaigns (Active/Pending/Paused)`);

      // CL-4: Clean up metadata cache for campaigns no longer in active list
      const activeIdSet = new Set(campaigns.map((c) => c.id));
      const allKeys = await chrome.storage.local.get(null);
      const staleMetaKeys = Object.keys(allKeys).filter((k) => {
        if (!k.startsWith("metadata:") && !k.startsWith("metadata_ts:") && !k.startsWith("metadata_url:")) return false;
        const cid = k.replace("metadata:", "").replace("metadata_ts:", "").replace("metadata_url:", "");
        return !activeIdSet.has(cid);
      });
      if (staleMetaKeys.length > 0) {
        await chrome.storage.local.remove(staleMetaKeys);
        console.log(`[DATUM] Cleaned ${staleMetaKeys.length} stale metadata cache entries`);
      }

      // Fetch IPFS metadata for campaigns (multi-gateway for reliability)
      const primaryGateway = ipfsGateway || "https://dweb.link/ipfs/";
      const gateways = [
        primaryGateway,
        "https://ipfs.io/ipfs/",
        "https://cloudflare-ipfs.com/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
      ];
      const uniqueGateways = [...new Set(gateways.map(g => g.endsWith("/") ? g : g + "/"))];

      for (const c of campaigns) {
        if (!c.metadataHash) continue;

        const metaKey = `metadata:${c.id}`;
        const tsKey = `metadata_ts:${c.id}`;
        const existing = await chrome.storage.local.get([metaKey, tsKey]);
        if (existing[metaKey]) {
          const fetchedAt = existing[tsKey] as number | undefined;
          if (fetchedAt && Date.now() - fetchedAt < METADATA_TTL_MS) continue;
        }

        let fetched = false;
        for (const gw of uniqueGateways) {
          try {
            const url = metadataUrl(c.metadataHash, gw);
            if (!url) continue;

            const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) continue;

            // Size cap: check Content-Length header first, then body length
            const contentLength = resp.headers.get("content-length");
            if (contentLength && parseInt(contentLength, 10) > MAX_METADATA_BYTES) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} exceeds ${MAX_METADATA_BYTES}B (Content-Length: ${contentLength}), skipping`);
              fetched = true; // Don't retry — content is too large on any gateway
              break;
            }

            const bodyText = await resp.text();
            if (bodyText.length > MAX_METADATA_BYTES) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} exceeds ${MAX_METADATA_BYTES}B (body: ${bodyText.length}), skipping`);
              fetched = true;
              break;
            }

            const rawMeta = JSON.parse(bodyText);
            const meta = validateAndSanitize(rawMeta);
            if (!meta) {
              console.warn(`[DATUM] Metadata for campaign ${c.id} failed validation, skipping`);
              fetched = true;
              break;
            }

            // Check CTA URL against phishing deny list
            if (meta.creative.ctaUrl && await isUrlPhishing(meta.creative.ctaUrl)) {
              console.warn(`[DATUM] Campaign ${c.id} CTA URL flagged as phishing: ${meta.creative.ctaUrl}`);
              fetched = true;
              break;
            }

            await chrome.storage.local.set({ [metaKey]: meta, [tsKey]: Date.now() });
            console.log(`[DATUM] Cached metadata for campaign ${c.id} via ${gw}`);
            fetched = true;
            break;
          } catch {
            // Try next gateway
            continue;
          }
        }
        if (!fetched) {
          console.warn(`[DATUM] All gateways failed for campaign ${c.id} metadata`);
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
  metadataHash?: string;  // bytes32 from CampaignMetadataSet event
}
