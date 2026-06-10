// Impression history log — persists the last MAX_ENTRIES impression events.
// Separate from claimQueue (which is ephemeral — drained on settlement).
// Used by the History page to show campaign activity and estimated earnings.

const LOG_KEY = "impressionLog";
const MAX_ENTRIES = 100;

export interface ImpressionLogEntry {
  id: string;              // `${timestamp}-${campaignId}-${nonce}`
  campaignId: string;
  publisherAddress: string;
  rateWei: string;      // clearing CPM for type-0; flat rate for type-1/2
  actionType: number;      // 0=view/CPM, 1=click/CPC, 2=remote-action/CPA
  timestamp: number;       // ms since epoch
  url: string;             // page where the ad was shown
  /** Estimated payout in planck. CPM: rateWei/1000; CPC/CPA: rateWei. */
  payoutWei: string;
}

/** Compute per-event payout from rate and action type. */
export function computePayout(rateWei: string, actionType: number): string {
  const rate = BigInt(rateWei);
  if (actionType === 0) {
    // CPM: cost per mille — divide by 1000 for per-impression value
    return (rate / 1000n).toString();
  }
  // CPC / CPA: flat rate per event
  return rate.toString();
}

export const impressionLog = {
  async add(entry: Omit<ImpressionLogEntry, "id" | "payoutWei">): Promise<void> {
    const stored = await chrome.storage.local.get(LOG_KEY);
    const log: ImpressionLogEntry[] = stored[LOG_KEY] ?? [];

    const payoutWei = computePayout(entry.rateWei, entry.actionType);
    const id = `${entry.timestamp}-${entry.campaignId}-${Math.random().toString(36).slice(2, 7)}`;

    log.unshift({ ...entry, id, payoutWei });

    // Trim to max entries
    if (log.length > MAX_ENTRIES) log.splice(MAX_ENTRIES);

    await chrome.storage.local.set({ [LOG_KEY]: log });
  },

  async getAll(): Promise<ImpressionLogEntry[]> {
    const stored = await chrome.storage.local.get(LOG_KEY);
    return stored[LOG_KEY] ?? [];
  },

  async clear(): Promise<void> {
    await chrome.storage.local.remove(LOG_KEY);
  },
};
