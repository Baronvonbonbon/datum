// Event-driven campaign poller with O(1) lookup index.
//
// Discovery: CampaignCreated events (1 RPC per poll for new events).
// First poll: query all historical events. Subsequent polls: query from lastBlock+1.
// Status refresh: multicall-style batch for known campaign IDs (only active/pending/paused).
// Storage: Map<id, campaign> serialized as object for O(1) lookups.
// No MAX_SCAN_ID limit — handles arbitrary campaign counts.

import { JsonRpcProvider, Contract } from "ethers";
import { getCampaignsContract, getBudgetLedgerContract, getReadProvider } from "@shared/contracts";
import { metadataUrl } from "@shared/ipfs";
import { CampaignStatus, ContractAddresses } from "@shared/types";
import { validateAndSanitize, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { isUrlPhishing, isAddressBlocked, refreshPhishingList } from "@shared/phishingList";
import { CATEGORY_TO_TAG, tagHash } from "@shared/tagDictionary";

const STORAGE_KEY = "activeCampaigns";
const INDEX_KEY = "campaignIndex";       // Map<id, campaign> as Record<string,SerializedCampaign>
const LAST_BLOCK_KEY = "pollLastBlock";  // highest block scanned (for forward / new-block scanning)
const SCAN_BACK_KEY = "pollScanBackBlock"; // lowest block yet to scan backwards (0=done, undefined=not started)
const METADATA_TTL_MS = 3600_000;        // 1 hour cache TTL for IPFS metadata
const BATCH_SIZE = 5;                    // parallel RPC calls per batch (low to avoid Paseo rate limits)
const EVENT_CHUNK_SIZE = 10_000;         // max block range per eth_getLogs request
const CHUNK_DELAY_MS = 300;              // delay between eth_getLogs chunks to avoid rate limits

// In-memory lock: true while a full poll() is running, so refreshStatus() yields.
let _polling = false;

const TERMINAL_STATUSES = new Set([
  CampaignStatus.Completed.toString(),
  CampaignStatus.Terminated.toString(),
  CampaignStatus.Expired.toString(),
  "99", // blocked sentinel
]);

// All fields stored as strings (already serialized from BigInt)
interface SerializedCampaign {
  id: string;
  advertiser: string;
  publisher: string;
  remainingBudget: string;
  viewBid: string;           // view pot ratePlanck (CPM); "0" if no view pot
  clickBid: string;          // click pot ratePlanck (flat per-click); "0" if no click pot
  actionBid: string;         // remote-action pot ratePlanck; "0" if no action pot
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
  async poll(rpcUrl: string, addresses: ContractAddresses, ipfsGateway?: string, pineChain?: string): Promise<void> {
    if (_polling) {
      console.log("[DATUM] poll() skipped — already in progress");
      return;
    }
    _polling = true;
    try {
      if (!addresses.campaigns || !addresses.campaigns.startsWith("0x")) {
        console.warn("[DATUM] Skipping poll — no valid campaigns contract address");
        return;
      }

      await refreshPhishingList();

      const provider = await getReadProvider(rpcUrl, !!pineChain, pineChain);
      const contract = getCampaignsContract(addresses, provider);
      if (!contract) return;
      const ledger = addresses.budgetLedger
        ? getBudgetLedgerContract(addresses, provider) : null;

      // Load existing index from storage
      const stored = await chrome.storage.local.get([INDEX_KEY, LAST_BLOCK_KEY, SCAN_BACK_KEY]);
      const index: Record<string, SerializedCampaign> = stored[INDEX_KEY] ?? {};
      const lastBlock: number = stored[LAST_BLOCK_KEY] ?? -1;
      // undefined = first poll not yet complete; 0 = fully scanned to genesis; N = continue from N-1
      const scanBackBlock: number | undefined = stored[SCAN_BACK_KEY];

      // ── Phase 1: Campaign discovery ────────────────────────────────────
      // Backward-first strategy: scan the most recent chunk on the first poll so campaigns
      // can start serving ads immediately, then extend one chunk backward per poll cycle
      // until the full chain history has been covered.
      //
      // pollLastBlock  — highest block scanned; -1 = never polled.
      // pollScanBackBlock — lowest block yet to scan; undefined = first poll pending;
      //                     0 = history complete; N = next backward chunk ends at N-1.
      //
      // Pine path: eth_getLogs unsupported — use nextCampaignId enumeration instead.
      const currentBlock = await provider.getBlockNumber();
      const isFirstPoll = lastBlock < 0;

      // Forward window: most recent chunk only on first poll; new blocks only thereafter.
      const forwardFrom = isFirstPoll
        ? Math.max(0, currentBlock - EVENT_CHUNK_SIZE + 1)
        : lastBlock + 1;

      let newCampaignIds: string[] = [];
      // nextScanBackBlock is written to storage at the end of the poll.
      let nextScanBackBlock: number | undefined = scanBackBlock;

      // Helper: bootstrap a campaign entry from CampaignCreated event args.
      // Returns the new campaign ID, or null if already in the index.
      const addFromCreatedEvent = (args: any): string | null => {
        const cid = (args[0] ?? args.campaignId)?.toString();
        if (!cid || index[cid]) return null;
        const advertiser = (args[1] ?? args.advertiser) ?? "";
        const publisher  = (args[2] ?? args.publisher)  ?? "";
        const snapshotTakeRateBps = Number(args[6] ?? args.snapshotTakeRateBps ?? 0).toString();
        const categoryId          = Number(args[7] ?? args.categoryId ?? 0).toString();
        index[cid] = {
          id: cid,
          advertiser: advertiser.toString(),
          publisher: publisher.toString(),
          remainingBudget: "0",
          viewBid: "0",    // filled in by Phase 2 getCampaignViewBid call
          clickBid: "0",   // filled in by Phase 2 getCampaignPots call
          actionBid: "0",  // filled in by Phase 2 getCampaignPots call
          snapshotTakeRateBps,
          status: CampaignStatus.Pending.toString(),
          categoryId,
          pendingExpiryBlock: "0",
          terminationBlock: "0",
        };
        return cid;
      };

      // Helper: apply a CampaignMetadataSet event to the index.
      const applyMetadataEvent = (args: any): void => {
        const cid = (args[0] ?? args.campaignId)?.toString();
        const hash: string = args[1] ?? args.metadataHash ?? "";
        if (cid && hash && index[cid]) index[cid].metadataHash = hash;
      };

      if (forwardFrom <= currentBlock) {
        // Pine path: eth_getLogs unsupported — enumerate via nextCampaignId directly
        if (pineChain) {
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
                  viewBid: "0",
                  clickBid: "0",
                  actionBid: "0",
                  snapshotTakeRateBps: "0",
                  status: CampaignStatus.Pending.toString(),
                  categoryId: "0",
                  pendingExpiryBlock: "0",
                  terminationBlock: "0",
                };
              }
            }
          } catch { /* give up on discovery this cycle */ }
        } else {
          // ── Phase 1a: Forward scan (most recent chunk / new blocks since last poll) ──
          try {
            const filter = contract.filters.CampaignCreated();
            const allEvents: any[] = [];
            for (let chunkFrom = forwardFrom; chunkFrom <= currentBlock; chunkFrom += EVENT_CHUNK_SIZE) {
              const chunkTo = Math.min(chunkFrom + EVENT_CHUNK_SIZE - 1, currentBlock);
              const chunk = await contract.queryFilter(filter, chunkFrom, chunkTo);
              allEvents.push(...chunk);
              if (chunkFrom + EVENT_CHUNK_SIZE <= currentBlock) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
              }
            }
            for (const ev of allEvents) {
              if (!(ev as any).args) continue;
              const cid = addFromCreatedEvent((ev as any).args);
              if (cid) newCampaignIds.push(cid);
            }
          } catch (err) {
            console.warn("[DATUM] Forward event query failed, falling back to nextCampaignId scan:", err);
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
                    viewBid: "0",
                    clickBid: "0",
                    actionBid: "0",
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

          // ── Phase 1b: Metadata events for the forward window ─────────────
          try {
            const metaFilter = contract.filters.CampaignMetadataSet();
            const allMetaEvents: any[] = [];
            for (let chunkFrom = forwardFrom; chunkFrom <= currentBlock; chunkFrom += EVENT_CHUNK_SIZE) {
              const chunkTo = Math.min(chunkFrom + EVENT_CHUNK_SIZE - 1, currentBlock);
              const chunk = await contract.queryFilter(metaFilter, chunkFrom, chunkTo);
              allMetaEvents.push(...chunk);
              if (chunkFrom + EVENT_CHUNK_SIZE <= currentBlock) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
              }
            }
            for (const ev of allMetaEvents) {
              if ((ev as any).args) applyMetadataEvent((ev as any).args);
            }
          } catch (err) {
            console.warn("[DATUM] Forward metadata event query failed:", err);
          }

          // After the first poll, anchor the backward scan start just before the forward window.
          if (isFirstPoll) {
            nextScanBackBlock = forwardFrom > 0 ? forwardFrom - 1 : 0;
          }

          // ── Phase 1c: Backward scan — one historical chunk per poll cycle ──
          // Each poll extends the scanned history by one chunk going further into the past.
          // Skipped on the first poll (nextScanBackBlock was just initialised above, not loaded).
          if (!isFirstPoll && nextScanBackBlock !== undefined && nextScanBackBlock > 0) {
            const backTo   = nextScanBackBlock - 1;
            const backFrom = Math.max(0, backTo - EVENT_CHUNK_SIZE + 1);
            try {
              const backNewIds: string[] = [];

              const filter = contract.filters.CampaignCreated();
              const backEvents = await contract.queryFilter(filter, backFrom, backTo);
              for (const ev of backEvents) {
                if (!(ev as any).args) continue;
                const cid = addFromCreatedEvent((ev as any).args);
                if (cid) { newCampaignIds.push(cid); backNewIds.push(cid); }
              }

              const metaFilter = contract.filters.CampaignMetadataSet();
              const backMetaEvents = await contract.queryFilter(metaFilter, backFrom, backTo);
              for (const ev of backMetaEvents) {
                if ((ev as any).args) applyMetadataEvent((ev as any).args);
              }

              nextScanBackBlock = backFrom > 0 ? backFrom : 0;
              const progress = nextScanBackBlock > 0
                ? `next from block ${nextScanBackBlock}`
                : "history complete";
              console.log(`[DATUM] Backward scan ${backFrom}→${backTo}: ${backNewIds.length} new campaigns (${progress})`);
            } catch (err) {
              console.warn("[DATUM] Backward scan chunk failed (will retry next poll):", err);
              // Do not advance nextScanBackBlock — same chunk retried next poll.
            }
          }
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
          const [status, settlementData, viewBid, pots, relaySigner, requiresZkProof] = await Promise.all([
            contract.getCampaignStatus(BigInt(id)).then(Number),
            contract.getCampaignForSettlement(BigInt(id)),
            contract.getCampaignViewBid(BigInt(id)).catch(() => 0n),
            contract.getCampaignPots(BigInt(id)).catch(() => [] as any[]),
            contract.getCampaignRelaySigner(BigInt(id)).catch(() => null),
            contract.getCampaignRequiresZkProof(BigInt(id)).catch(() => false),
          ]);

          const camp = index[id];
          camp.status = status.toString();
          camp.publisher = settlementData[1] ?? camp.publisher;
          camp.snapshotTakeRateBps = Number(settlementData[2]).toString();
          camp.viewBid = BigInt(viewBid).toString();

          // Extract click (type-1) and remote-action (type-2) pot rates
          if (Array.isArray(pots)) {
            for (const pot of pots) {
              const aType = Number(pot.actionType ?? pot[0]);
              const rate = BigInt(pot.ratePlanck ?? pot[3] ?? 0n).toString();
              if (aType === 1) camp.clickBid = rate;
              if (aType === 2) camp.actionBid = rate;
            }
          }

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

      // ── Phase 2b: Fetch tags + metadata for new campaigns + self-heal ────
      // Include new campaigns AND any cached campaigns with empty/missing requiredTags
      // or missing metadataHash, so the index self-heals across polls.
      const tagFetchIds = [
        ...newCampaignIds,
        ...Object.keys(index).filter(id =>
          !newCampaignIds.includes(id) &&
          ((!index[id].requiredTags || index[id].requiredTags!.length === 0) ||
           !index[id].metadataHash)
        ),
      ];
      const tagTasks = tagFetchIds.map(id => async () => {
        try {
          const [tags, metaHash] = await Promise.all([
            contract.getCampaignTags(BigInt(id)).catch(() => [] as string[]),
            contract.getCampaignMetadata(BigInt(id)).catch(() => null as string | null),
          ]);
          if (tags.length > 0) index[id].requiredTags = tags;
          // bytes32 zero = no metadata set; non-zero = valid IPFS CID hash
          if (metaHash && metaHash !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
            index[id].metadataHash = metaHash;
          }
        } catch { /* skip */ }
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
      for (const id of Object.keys(index)) {
        if (TERMINAL_STATUSES.has(index[id].status)) {
          delete index[id];
        }
      }

      // Build flat array for backward compat with content script / auction
      const activeCampaigns = Object.values(index);

      const persistData: Record<string, any> = {
        [INDEX_KEY]: index,
        [LAST_BLOCK_KEY]: currentBlock,
        [STORAGE_KEY]: activeCampaigns,
      };
      if (nextScanBackBlock !== undefined) persistData[SCAN_BACK_KEY] = nextScanBackBlock;
      await chrome.storage.local.set(persistData);

      const scanProgress = nextScanBackBlock === undefined ? "first poll"
        : nextScanBackBlock === 0 ? "history complete"
        : `back to block ${nextScanBackBlock}`;
      console.log(`[DATUM] Polled ${activeCampaigns.length} campaigns (${newCampaignIds.length} new, fwd ${forwardFrom}→${currentBlock}, ${scanProgress})`);

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
    } finally {
      _polling = false;
    }
  },

  /**
   * Lightweight status-only refresh for known campaigns.
   * Runs Phase 2+3 only — no event scan, no IPFS fetch.
   * Yields immediately if a full poll() is in progress.
   */
  async refreshStatus(rpcUrl: string, addresses: ContractAddresses, pineChain?: string): Promise<void> {
    if (_polling) return; // full poll in progress — it will update status too
    if (!addresses.campaigns || !addresses.campaigns.startsWith("0x")) return;

    try {
      const provider = await getReadProvider(rpcUrl, !!pineChain, pineChain);
      const contract = getCampaignsContract(addresses, provider);
      if (!contract) return;
      const ledger = addresses.budgetLedger
        ? getBudgetLedgerContract(addresses, provider) : null;

      const stored = await chrome.storage.local.get([INDEX_KEY]);
      const index: Record<string, SerializedCampaign> = stored[INDEX_KEY] ?? {};

      const refreshIds = Object.keys(index).filter(id => {
        const s = Number(index[id].status);
        return s === CampaignStatus.Active || s === CampaignStatus.Pending || s === CampaignStatus.Paused;
      });

      if (refreshIds.length === 0) return;

      const statusTasks = refreshIds.map(id => async () => {
        try {
          const [status, settlementData, viewBid, pots, relaySigner, requiresZkProof] = await Promise.all([
            contract.getCampaignStatus(BigInt(id)).then(Number),
            contract.getCampaignForSettlement(BigInt(id)),
            contract.getCampaignViewBid(BigInt(id)).catch(() => 0n),
            contract.getCampaignPots(BigInt(id)).catch(() => [] as any[]),
            contract.getCampaignRelaySigner(BigInt(id)).catch(() => null),
            contract.getCampaignRequiresZkProof(BigInt(id)).catch(() => false),
          ]);

          const camp = index[id];
          camp.status = status.toString();
          camp.publisher = settlementData[1] ?? camp.publisher;
          camp.snapshotTakeRateBps = Number(settlementData[2]).toString();
          camp.viewBid = BigInt(viewBid).toString();

          if (Array.isArray(pots)) {
            for (const pot of pots) {
              const aType = Number(pot.actionType ?? pot[0]);
              const rate = BigInt(pot.ratePlanck ?? pot[3] ?? 0n).toString();
              if (aType === 1) camp.clickBid = rate;
              if (aType === 2) camp.actionBid = rate;
            }
          }

          if (relaySigner && relaySigner !== "0x0000000000000000000000000000000000000000") {
            camp.relaySigner = relaySigner;
          }
          camp.requiresZkProof = !!requiresZkProof;

          if (await isAddressBlocked(camp.advertiser)) {
            camp.status = "99";
            return;
          }

          if (ledger && (status === CampaignStatus.Active || status === CampaignStatus.Pending)) {
            try {
              camp.remainingBudget = BigInt(await ledger.getRemainingBudget(BigInt(id))).toString();
            } catch { /* keep existing */ }
          }
        } catch { /* RPC failed — keep existing status */ }
      });

      await batchParallel(statusTasks, BATCH_SIZE);

      // Remove newly-terminal campaigns
      for (const id of Object.keys(index)) {
        if (TERMINAL_STATUSES.has(index[id].status)) {
          delete index[id];
        }
      }

      const activeCampaigns = Object.values(index);
      await chrome.storage.local.set({
        [INDEX_KEY]: index,
        [STORAGE_KEY]: activeCampaigns,
      });
      console.log(`[DATUM] Status refresh: ${activeCampaigns.length} campaigns (${refreshIds.length} checked)`);
    } catch (err) {
      console.error("[DATUM] campaignPoller.refreshStatus failed:", err);
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
    await chrome.storage.local.remove([STORAGE_KEY, INDEX_KEY, LAST_BLOCK_KEY, SCAN_BACK_KEY]);
  },
};
