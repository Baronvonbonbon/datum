// Event-driven campaign poller with O(1) lookup index.
//
// Discovery: CampaignCreated events (1 RPC per poll for new events).
// First poll: query all historical events. Subsequent polls: query from lastBlock+1.
// Status refresh: multicall-style batch for known campaign IDs (only active/pending/paused).
// Storage: Map<id, campaign> serialized as object for O(1) lookups.
// No MAX_SCAN_ID limit — handles arbitrary campaign counts.

import { JsonRpcProvider, Contract } from "ethers";
import { getCampaignsContract, getBudgetLedgerContract } from "@shared/contracts";
import { metadataUrl } from "@shared/ipfs";
import { CampaignStatus, ContractAddresses } from "@shared/types";
import { validateAndSanitize, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { isUrlPhishing, isAddressBlocked, refreshPhishingList } from "@shared/phishingList";
import { CATEGORY_TO_TAG, tagHash } from "@shared/tagDictionary";

const STORAGE_KEY = "activeCampaigns";
const INDEX_KEY = "campaignIndex";       // Map<id, campaign> as Record<string,SerializedCampaign>
const LAST_BLOCK_KEY = "pollLastBlock";  // last block scanned for events
const METADATA_TTL_MS = 3600_000;        // 1 hour cache TTL for IPFS metadata
const BATCH_SIZE = 5;                    // parallel RPC calls per batch (low to avoid Paseo rate limits)
const EVENT_CHUNK_SIZE = 10_000;         // max block range per eth_getLogs request
const CHUNK_DELAY_MS = 300;              // delay between eth_getLogs chunks to avoid rate limits

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
  /** @deprecated Use requiredTags for matching. Kept for backward compat synthesis. */
  categoryId: string;
  pendingExpiryBlock: string;
  terminationBlock: string;
  metadataHash?: string;
  requiredTags?: string[];
  relaySigner?: string;
  requiresZkProof?: boolean;
}

/** Batch an array of async tasks into groups of `size`, running each group in parallel. */
async function batchParallel<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}

export const campaignPoller = {
  async poll(rpcUrl: string, addresses: ContractAddresses, ipfsGateway?: string): Promise<void> {
    try {
      if (!addresses.campaigns || !addresses.campaigns.startsWith("0x")) {
        console.warn("[DATUM] Skipping poll — no valid campaigns contract address");
        return;
      }

      await refreshPhishingList();

      const provider = new JsonRpcProvider(rpcUrl);
      const contract = getCampaignsContract(addresses, provider);
      if (!contract) return;
      const ledger = addresses.budgetLedger
        ? getBudgetLedgerContract(addresses, provider) : null;

      // Load existing index from storage
      const stored = await chrome.storage.local.get([INDEX_KEY, LAST_BLOCK_KEY]);
      const index: Record<string, SerializedCampaign> = stored[INDEX_KEY] ?? {};
      const lastBlock: number = stored[LAST_BLOCK_KEY] ?? 0;

      // ── Phase 1: Event-driven discovery ────────────────────────────────
      // Query CampaignCreated events since lastBlock (or all if first run)
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = lastBlock > 0 ? lastBlock + 1 : 0;
      let newCampaignIds: string[] = [];

      if (fromBlock <= currentBlock) {
        try {
          const filter = contract.filters.CampaignCreated();
          // Chunk large ranges to stay within public RPC limits (some nodes cap at 10k blocks).
          const allEvents: any[] = [];
          for (let chunkFrom = fromBlock; chunkFrom <= currentBlock; chunkFrom += EVENT_CHUNK_SIZE) {
            const chunkTo = Math.min(chunkFrom + EVENT_CHUNK_SIZE - 1, currentBlock);
            const chunk = await contract.queryFilter(filter, chunkFrom, chunkTo);
            allEvents.push(...chunk);
            // Throttle between chunks to avoid hitting Paseo public RPC rate limits
            if (chunkFrom + EVENT_CHUNK_SIZE <= currentBlock) {
              await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
            }
          }
          for (const ev of allEvents) {
            const args = (ev as any).args;
            if (!args) continue;
            const cid = (args[0] ?? args.campaignId)?.toString();
            if (!cid) continue;

            // Bootstrap new campaign entry from event data
            if (!index[cid]) {
              const advertiser = (args[1] ?? args.advertiser) ?? "";
              const publisher = (args[2] ?? args.publisher) ?? "";
              const dailyCap = BigInt(args[4] ?? args.dailyCapPlanck ?? 0).toString();
              const bidCpmPlanck = BigInt(args[5] ?? args.bidCpmPlanck ?? 0).toString();
              const snapshotTakeRateBps = Number(args[6] ?? args.snapshotTakeRateBps ?? 0).toString();
              const categoryId = Number(args[7] ?? args.categoryId ?? 0).toString();

              index[cid] = {
                id: cid,
                advertiser: advertiser.toString(),
                publisher: publisher.toString(),
                remainingBudget: "0",
                dailyCap,
                bidCpmPlanck,
                snapshotTakeRateBps,
                status: CampaignStatus.Pending.toString(),
                categoryId,
                pendingExpiryBlock: "0",
                terminationBlock: "0",
              };
              newCampaignIds.push(cid);
            }
          }
        } catch (err) {
          console.warn("[DATUM] Event query failed, falling back to nextCampaignId scan:", err);
          // Fallback: enumerate IDs via nextCampaignId and bootstrap stub entries.
          // Without bootstrapping index, Phase 2 would never refresh the new IDs.
          try {
            const nextId = Number(await contract.nextCampaignId());
            for (let id = 1; id < nextId; id++) {
              const sid = id.toString();
              if (!index[sid]) {
                newCampaignIds.push(sid);
                index[sid] = {
                  id: sid,
                  advertiser: "",
                  publisher: "",
                  remainingBudget: "0",
                  dailyCap: "0",
                  bidCpmPlanck: "0",
                  snapshotTakeRateBps: "0",
                  status: CampaignStatus.Pending.toString(),
                  categoryId: "0",
                  pendingExpiryBlock: "0",
                  terminationBlock: "0",
                };
              }
            }
          } catch { /* give up on discovery this cycle */ }
        }
      }

      // ── Phase 1b: Metadata events for new campaigns ────────────────────
      if (fromBlock <= currentBlock) {
        try {
          const metaFilter = contract.filters.CampaignMetadataSet();
          const allMetaEvents: any[] = [];
          for (let chunkFrom = fromBlock; chunkFrom <= currentBlock; chunkFrom += EVENT_CHUNK_SIZE) {
            const chunkTo = Math.min(chunkFrom + EVENT_CHUNK_SIZE - 1, currentBlock);
            const chunk = await contract.queryFilter(metaFilter, chunkFrom, chunkTo);
            allMetaEvents.push(...chunk);
            if (chunkFrom + EVENT_CHUNK_SIZE <= currentBlock) {
              await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
            }
          }
          for (const ev of allMetaEvents) {
            const args = (ev as any).args;
            if (!args) continue;
            const cid = (args[0] ?? args.campaignId)?.toString();
            const hash: string = args[1] ?? args.metadataHash ?? "";
            if (cid && hash && index[cid]) {
              index[cid].metadataHash = hash;
            }
          }
        } catch (err) {
          console.warn("[DATUM] Metadata event query failed:", err);
        }
      }

      // ── Phase 2: Refresh status for all known non-terminal campaigns ───
      // Only refresh campaigns that are Active, Pending, or Paused
      const refreshIds = Object.keys(index).filter(id => {
        const s = Number(index[id].status);
        return s === CampaignStatus.Active || s === CampaignStatus.Pending || s === CampaignStatus.Paused;
      });

      // Batch status + settlement data refresh
      const statusTasks = refreshIds.map(id => async () => {
        try {
          const [status, settlementData, relaySigner, requiresZkProof] = await Promise.all([
            contract.getCampaignStatus(BigInt(id)).then(Number),
            contract.getCampaignForSettlement(BigInt(id)),
            contract.getCampaignRelaySigner(BigInt(id)).catch(() => null),
            contract.getCampaignRequiresZkProof(BigInt(id)).catch(() => false),
          ]);

          const camp = index[id];
          camp.status = status.toString();
          camp.publisher = settlementData[1] ?? camp.publisher;
          camp.bidCpmPlanck = BigInt(settlementData[2]).toString();
          camp.snapshotTakeRateBps = Number(settlementData[3]).toString();
          if (relaySigner && relaySigner !== "0x0000000000000000000000000000000000000000") {
            camp.relaySigner = relaySigner;
          }
          camp.requiresZkProof = !!requiresZkProof;

          // Check advertiser from settlement data or keep existing
          const advertiser = camp.advertiser;
          if (await isAddressBlocked(advertiser)) {
            // Mark as terminal so we stop polling it
            camp.status = "99"; // sentinel: blocked
            return;
          }

          // Budget refresh
          if (ledger && (status === CampaignStatus.Active || status === CampaignStatus.Pending)) {
            try {
              camp.remainingBudget = BigInt(await ledger.getRemainingBudget(BigInt(id))).toString();
            } catch { /* keep existing */ }
          }
        } catch {
          // Campaign may not exist or RPC failed — mark terminal after repeated failures
        }
      });

      await batchParallel(statusTasks, BATCH_SIZE);

      // ── Phase 2b: Fetch tags for new campaigns ─────────────────────────
      const tagTasks = newCampaignIds.map(id => async () => {
        try {
          const tags: string[] = await contract.getCampaignTags(BigInt(id));
          if (tags.length > 0) index[id].requiredTags = tags;
        } catch { /* getCampaignTags may not exist — skip */ }
      });
      await batchParallel(tagTasks, BATCH_SIZE);

      // ── Phase 2c: Synthesize requiredTags from categoryId (backward compat) ──
      // For campaigns with categoryId > 0 and no requiredTags, generate a synthetic
      // requiredTags array. This centralizes backward compat so downstream code
      // (content script matching, auction) only needs to check requiredTags.
      for (const id of Object.keys(index)) {
        const camp = index[id];
        const catId = Number(camp.categoryId);
        if (catId > 0 && (!camp.requiredTags || camp.requiredTags.length === 0)) {
          const tagStr = CATEGORY_TO_TAG[catId];
          if (tagStr) {
            camp.requiredTags = [tagHash(tagStr)];
          }
        }
      }

      // ── Phase 3: Build active list + persist ───────────────────────────
      // Remove terminal campaigns from index (Completed, Terminated, Expired, blocked)
      const terminalStatuses = new Set([
        CampaignStatus.Completed.toString(),
        CampaignStatus.Terminated.toString(),
        CampaignStatus.Expired.toString(),
        "99", // blocked sentinel
      ]);
      for (const id of Object.keys(index)) {
        if (terminalStatuses.has(index[id].status)) {
          delete index[id];
        }
      }

      // Build flat array for backward compat with content script / auction
      const activeCampaigns = Object.values(index);

      await chrome.storage.local.set({
        [INDEX_KEY]: index,
        [LAST_BLOCK_KEY]: currentBlock,
        [STORAGE_KEY]: activeCampaigns,
      });
      console.log(`[DATUM] Polled ${activeCampaigns.length} campaigns (${newCampaignIds.length} new, block ${fromBlock}→${currentBlock})`);

      // ── Phase 4: Metadata cleanup ──────────────────────────────────────
      const activeIdSet = new Set(activeCampaigns.map(c => c.id));
      const allKeys = await chrome.storage.local.get(null);
      const staleMetaKeys = Object.keys(allKeys).filter(k => {
        if (!k.startsWith("metadata:") && !k.startsWith("metadata_ts:") && !k.startsWith("metadata_url:")) return false;
        const cid = k.split(":")[1];
        return !activeIdSet.has(cid);
      });
      if (staleMetaKeys.length > 0) {
        await chrome.storage.local.remove(staleMetaKeys);
      }

      // ── Phase 5: IPFS metadata fetch ───────────────────────────────────
      const primaryGateway = ipfsGateway || "https://dweb.link/ipfs/";
      const gateways = [
        primaryGateway,
        "https://ipfs.io/ipfs/",
        "https://cloudflare-ipfs.com/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
      ];
      const uniqueGateways = [...new Set(gateways.map(g => g.endsWith("/") ? g : g + "/"))];

      // Only fetch metadata for campaigns that need it (new or expired TTL)
      const metaTasks = activeCampaigns
        .filter(c => c.metadataHash)
        .map(c => async () => {
          const metaKey = `metadata:${c.id}`;
          const tsKey = `metadata_ts:${c.id}`;
          const existing = await chrome.storage.local.get([metaKey, tsKey]);
          if (existing[metaKey]) {
            const fetchedAt = existing[tsKey] as number | undefined;
            if (fetchedAt && Date.now() - fetchedAt < METADATA_TTL_MS) return;
          }

          for (const gw of uniqueGateways) {
            try {
              const url = metadataUrl(c.metadataHash!, gw);
              if (!url) continue;
              const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
              if (!resp.ok) continue;
              const contentLength = resp.headers.get("content-length");
              if (contentLength && parseInt(contentLength, 10) > MAX_METADATA_BYTES) break;
              const bodyText = await resp.text();
              if (bodyText.length > MAX_METADATA_BYTES) break;
              const rawMeta = JSON.parse(bodyText);
              const meta = validateAndSanitize(rawMeta);
              if (!meta) break;
              if (meta.creative.ctaUrl && await isUrlPhishing(meta.creative.ctaUrl)) break;
              await chrome.storage.local.set({ [metaKey]: meta, [tsKey]: Date.now() });
              return; // success
            } catch { continue; }
          }
        });

      // Fetch metadata in batches (avoid overwhelming gateways)
      await batchParallel(metaTasks, 5);

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

  /** O(1) lookup by campaign ID from the indexed store. */
  async getById(campaignId: string): Promise<SerializedCampaign | null> {
    const stored = await chrome.storage.local.get(INDEX_KEY);
    const index: Record<string, SerializedCampaign> = stored[INDEX_KEY] ?? {};
    return index[campaignId] ?? null;
  },

  /** Reset poller state (forces full re-scan on next poll). */
  async reset(): Promise<void> {
    await chrome.storage.local.remove([STORAGE_KEY, INDEX_KEY, LAST_BLOCK_KEY]);
  },
};
