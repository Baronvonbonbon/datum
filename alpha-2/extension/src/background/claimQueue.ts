// Manages the pending claim queue and auto-flush logic.

import { Claim, ClaimBatch } from "@shared/types";

const QUEUE_KEY = "claimQueue";
const LAST_FLUSH_KEY = "lastAutoFlush";
const SUBMITTING_KEY = "submitting";
const SUBMITTING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface SerializedClaim {
  campaignId: string;
  publisher: string;
  impressionCount: string;
  clearingCpmPlanck: string;
  nonce: string;
  previousClaimHash: string;
  claimHash: string;
  zkProof: string;
  userAddress: string;
}

export const claimQueue = {
  async getState(): Promise<{
    pendingCount: number;
    byUser: Record<string, Record<string, number>>;
    lastFlush: number | null;
  }> {
    const stored = await chrome.storage.local.get([QUEUE_KEY, LAST_FLUSH_KEY]);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];

    const byUser: Record<string, Record<string, number>> = {};
    for (const c of queue) {
      if (!byUser[c.userAddress]) byUser[c.userAddress] = {};
      const cid = c.campaignId;
      byUser[c.userAddress][cid] = (byUser[c.userAddress][cid] ?? 0) + 1;
    }

    return {
      pendingCount: queue.length,
      byUser,
      lastFlush: stored[LAST_FLUSH_KEY] ?? null,
    };
  },

  async clear(): Promise<void> {
    await chrome.storage.local.remove(QUEUE_KEY);
  },

  // Submission mutex — prevents double-submission races between manual and auto-submit
  async acquireMutex(): Promise<boolean> {
    const stored = await chrome.storage.local.get(SUBMITTING_KEY);
    const state = stored[SUBMITTING_KEY] as { since: number } | undefined;
    if (state) {
      // If stale (held > 5 minutes), force-clear and allow
      if (Date.now() - state.since < SUBMITTING_TIMEOUT_MS) {
        return false; // locked
      }
    }
    await chrome.storage.local.set({ [SUBMITTING_KEY]: { since: Date.now() } });
    return true;
  },

  async releaseMutex(): Promise<void> {
    await chrome.storage.local.remove(SUBMITTING_KEY);
  },

  // Called by the popup when the user clicks "Submit All"
  async buildBatches(userAddress: string): Promise<ClaimBatch[]> {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];

    const userClaims = queue.filter((c) => c.userAddress === userAddress);
    if (userClaims.length === 0) return [];

    // Group by campaignId
    const byCampaign = new Map<string, SerializedClaim[]>();
    for (const c of userClaims) {
      const arr = byCampaign.get(c.campaignId) ?? [];
      arr.push(c);
      byCampaign.set(c.campaignId, arr);
    }

    return Array.from(byCampaign.entries()).map(([campaignId, claims]) => ({
      user: userAddress,
      campaignId: BigInt(campaignId),
      claims: claims.map(deserializeClaim),
    }));
  },

  // Remove claims for campaigns that are no longer active (e.g. withdrawn, terminated)
  async pruneInactiveCampaigns(activeCampaignIds: Set<string>): Promise<number> {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];
    if (queue.length === 0) return 0;

    const filtered = queue.filter((c) => activeCampaignIds.has(c.campaignId));
    const pruned = queue.length - filtered.length;
    if (pruned > 0) {
      await chrome.storage.local.set({ [QUEUE_KEY]: filtered });
    }
    return pruned;
  },

  // Build a single batch for one specific campaign (for per-campaign submit)
  async buildBatchForCampaign(userAddress: string, campaignId: string): Promise<ClaimBatch | null> {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];

    const campaignClaims = queue.filter(
      (c) => c.userAddress === userAddress && c.campaignId === campaignId
    );
    if (campaignClaims.length === 0) return null;

    return {
      user: userAddress,
      campaignId: BigInt(campaignId),
      claims: campaignClaims.map(deserializeClaim),
    };
  },

  // Remove all claims for a specific (user, campaign) pair
  async discardCampaignClaims(userAddress: string, campaignId: string): Promise<number> {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];

    const filtered = queue.filter(
      (c) => !(c.userAddress === userAddress && c.campaignId === campaignId)
    );
    const removed = queue.length - filtered.length;
    if (removed > 0) {
      await chrome.storage.local.set({ [QUEUE_KEY]: filtered });
    }
    return removed;
  },

  // Remove successfully settled claims from the queue
  async removeSettled(userAddress: string, settledNonces: Map<string, bigint[]>): Promise<void> {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];

    const filtered = queue.filter((c) => {
      if (c.userAddress !== userAddress) return true;
      const nonces = settledNonces.get(c.campaignId);
      if (!nonces) return true;
      return !nonces.includes(BigInt(c.nonce));
    });

    await chrome.storage.local.set({ [QUEUE_KEY]: filtered });
  },
};

function deserializeClaim(c: SerializedClaim): Claim {
  return {
    campaignId: BigInt(c.campaignId),
    publisher: c.publisher,
    impressionCount: BigInt(c.impressionCount),
    clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
    nonce: BigInt(c.nonce),
    previousClaimHash: c.previousClaimHash,
    claimHash: c.claimHash,
    zkProof: c.zkProof,
  };
}
