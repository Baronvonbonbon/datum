// Earnings indexer — pure module that parses ClaimSettled events and aggregates
// them into per-campaign totals + a recent ring buffer. Storage is supplied by
// the caller (extension uses chrome.storage.local; webapp can use a Map or
// browser localStorage). The module itself has no Chrome / DOM dependencies.
//
// Used by:
//   - extension/src/background/earningsListener.ts  (live + backfill)
//   - web/src/pages/me/History.tsx                  (on-demand scan)

import { Contract, EventLog, Log, Provider } from "ethers";
import settlementAbi from "./abis/DatumSettlement.json";
import {
  EarningsCampaignTotals,
  EarningsRecentEntry,
} from "./types";

// Maximum entries kept in the recent ring buffer. Oldest are evicted.
export const RECENT_BUFFER_SIZE = 50;

// Default Pine-friendly initial backfill window. ~50_000 blocks at 6s = ~3.5 days.
export const DEFAULT_BACKFILL_BLOCKS = 50_000;

// Chunk size for eth_getLogs. Pine RPC's window is ~10k blocks; stay under to
// keep both decentralized and centralized RPCs happy.
export const SCAN_CHUNK_BLOCKS = 5_000;

export interface EarningsIndex {
  byCampaign: Record<string, EarningsCampaignTotals>;
  recent: EarningsRecentEntry[];
  lastScannedBlock: number;
  // Per-(txHash, logIndex) dedup map — keyed `${txHash}:${logIndex}`. Capped at
  // RECENT_BUFFER_SIZE × 4 entries; old keys are pruned alongside ring eviction.
  seenLogs: Record<string, true>;
}

export function emptyIndex(): EarningsIndex {
  return { byCampaign: {}, recent: [], lastScannedBlock: 0, seenLogs: {} };
}

/**
 * Storage key for an account's earnings index. Scope by chain + address so
 * switching networks or accounts gets a fresh slice.
 */
export function earningsKey(chainId: number, address: string): string {
  return `earnings:${chainId}:${address.toLowerCase()}`;
}

/**
 * Parse a single ClaimSettled log into an entry the index can absorb.
 * Returns null if the log doesn't decode to a ClaimSettled event.
 */
export function decodeClaimSettled(
  log: Log | EventLog,
  iface: Contract["interface"]
): {
  campaignId: bigint;
  user: string;
  publisher: string;
  eventCount: bigint;
  ratePlanck: bigint;
  actionType: number;
  nonce: bigint;
  publisherPayment: bigint;
  userPayment: bigint;
  protocolFee: bigint;
  blockNumber: number;
  txHash: string;
  logIndex: number;
} | null {
  let parsed: ReturnType<Contract["interface"]["parseLog"]>;
  try {
    parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "ClaimSettled") return null;
  const a = parsed.args;
  return {
    campaignId: BigInt(a.campaignId),
    user: a.user,
    publisher: a.publisher,
    eventCount: BigInt(a.eventCount),
    ratePlanck: BigInt(a.ratePlanck),
    actionType: Number(a.actionType),
    nonce: BigInt(a.nonce),
    publisherPayment: BigInt(a.publisherPayment),
    userPayment: BigInt(a.userPayment),
    protocolFee: BigInt(a.protocolFee),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

/**
 * Apply a single decoded ClaimSettled event to the index. Idempotent on
 * (txHash, logIndex). Returns the index (mutated in place; returned for
 * chaining) and whether the event was newly applied.
 */
export function applyEvent(
  index: EarningsIndex,
  ev: NonNullable<ReturnType<typeof decodeClaimSettled>> & { blockTimestamp?: number }
): { index: EarningsIndex; applied: boolean } {
  const dedupKey = `${ev.txHash}:${ev.logIndex}`;
  if (index.seenLogs[dedupKey]) return { index, applied: false };

  const cid = ev.campaignId.toString();
  const existing = index.byCampaign[cid];
  if (existing) {
    index.byCampaign[cid] = {
      totalUserPlanck: (BigInt(existing.totalUserPlanck) + ev.userPayment).toString(),
      totalEvents: (BigInt(existing.totalEvents) + ev.eventCount).toString(),
      claimCount: existing.claimCount + 1,
      lastBlock: Math.max(existing.lastBlock, ev.blockNumber),
      lastPaymentPlanck: ev.userPayment.toString(),
      firstSeenBlock: Math.min(existing.firstSeenBlock, ev.blockNumber),
    };
  } else {
    index.byCampaign[cid] = {
      totalUserPlanck: ev.userPayment.toString(),
      totalEvents: ev.eventCount.toString(),
      claimCount: 1,
      lastBlock: ev.blockNumber,
      lastPaymentPlanck: ev.userPayment.toString(),
      firstSeenBlock: ev.blockNumber,
    };
  }

  // Skip zero-payment claims in the recent ring (not user-meaningful).
  if (ev.userPayment > 0n) {
    index.recent.unshift({
      campaignId: cid,
      blockNumber: ev.blockNumber,
      blockTimestamp: ev.blockTimestamp ?? 0,
      userPaymentPlanck: ev.userPayment.toString(),
      publisher: ev.publisher,
      actionType: ev.actionType as 0 | 1 | 2,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
    });
    if (index.recent.length > RECENT_BUFFER_SIZE) {
      index.recent.length = RECENT_BUFFER_SIZE;
    }
  }

  index.seenLogs[dedupKey] = true;
  if (ev.blockNumber > index.lastScannedBlock) {
    index.lastScannedBlock = ev.blockNumber;
  }

  // Bound the seenLogs map. We keep ~4× the recent buffer to absorb
  // chunk boundaries / re-scans without losing dedup. Pruning is approximate
  // and just trims the oldest map insertions when the cap is exceeded.
  const seenCap = RECENT_BUFFER_SIZE * 4;
  const seenKeys = Object.keys(index.seenLogs);
  if (seenKeys.length > seenCap) {
    for (let i = 0; i < seenKeys.length - seenCap; i++) {
      delete index.seenLogs[seenKeys[i]];
    }
  }

  return { index, applied: true };
}

/**
 * Scan ClaimSettled events for a single user across [fromBlock, toBlock] in
 * SCAN_CHUNK_BLOCKS-sized windows, applying each to `index`. Caller is
 * responsible for persistence — pass a callback to flush every N blocks if
 * needed, or persist after the whole call returns.
 *
 * Returns the number of newly-applied events.
 */
export async function scanRange(opts: {
  provider: Provider;
  settlementAddress: string;
  user: string;
  fromBlock: number;
  toBlock: number;
  index: EarningsIndex;
  enrichTimestamp?: boolean;          // fetch block timestamps (extra RPC)
  onProgress?: (scanned: number, total: number) => void;
}): Promise<number> {
  const { provider, settlementAddress, user, fromBlock, toBlock, index } = opts;
  const settlement = new Contract(settlementAddress, settlementAbi.abi, provider);
  const iface = settlement.interface;

  // topic2 = keccak256-abi-encoded address (left-padded to 32 bytes)
  const userTopic = "0x" + user.slice(2).toLowerCase().padStart(64, "0");
  const claimSettledTopic = settlement.getEvent("ClaimSettled").fragment.topicHash;

  const total = Math.max(0, toBlock - fromBlock + 1);
  let applied = 0;
  let scanned = 0;

  for (let from = fromBlock; from <= toBlock; from += SCAN_CHUNK_BLOCKS) {
    const to = Math.min(from + SCAN_CHUNK_BLOCKS - 1, toBlock);
    let logs: Log[] = [];
    try {
      logs = await provider.getLogs({
        address: settlementAddress,
        topics: [claimSettledTopic, null, userTopic],
        fromBlock: from,
        toBlock: to,
      });
    } catch (err) {
      // Surface RPC failure to caller via progress side-channel; keep scanning.
      // (Most likely cause on Pine: requested range exceeds rolling window.)
      console.warn(`[earnings] getLogs ${from}-${to} failed:`, err);
    }
    for (const log of logs) {
      const decoded = decodeClaimSettled(log, iface);
      if (!decoded) continue;
      let blockTimestamp: number | undefined = undefined;
      if (opts.enrichTimestamp) {
        try {
          const block = await provider.getBlock(decoded.blockNumber);
          if (block?.timestamp) blockTimestamp = Number(block.timestamp);
        } catch { /* timestamp is best-effort */ }
      }
      const { applied: did } = applyEvent(index, { ...decoded, blockTimestamp });
      if (did) applied++;
    }
    scanned += to - from + 1;
    opts.onProgress?.(scanned, total);
    index.lastScannedBlock = Math.max(index.lastScannedBlock, to);
  }

  return applied;
}

// ── Sort utilities ─────────────────────────────────────────────────────────

export type TopSortKey = "totalUserPlanck" | "claimCount" | "totalEvents" | "lastBlock";

export function topCampaigns(
  index: EarningsIndex,
  sortBy: TopSortKey = "totalUserPlanck",
  limit = 10
): Array<{ campaignId: string; totals: EarningsCampaignTotals }> {
  const entries = Object.entries(index.byCampaign).map(([campaignId, totals]) => ({
    campaignId,
    totals,
  }));
  entries.sort((a, b) => {
    const va = sortBy === "totalUserPlanck" ? BigInt(a.totals.totalUserPlanck) :
               sortBy === "totalEvents"     ? BigInt(a.totals.totalEvents) :
               BigInt(sortBy === "claimCount" ? a.totals.claimCount : a.totals.lastBlock);
    const vb = sortBy === "totalUserPlanck" ? BigInt(b.totals.totalUserPlanck) :
               sortBy === "totalEvents"     ? BigInt(b.totals.totalEvents) :
               BigInt(sortBy === "claimCount" ? b.totals.claimCount : b.totals.lastBlock);
    if (va > vb) return -1;
    if (va < vb) return 1;
    return 0;
  });
  return entries.slice(0, limit);
}
