// Manages the pending claim queue and auto-flush logic.

import { JsonRpcProvider, BrowserProvider } from "ethers";
import { getSettlementContract } from "@shared/contracts";
import { Claim, ClaimBatch } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/networks";

const QUEUE_KEY = "claimQueue";
const LAST_FLUSH_KEY = "lastAutoFlush";

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

  // Auto-flush called by the alarm — requires a stored signer (not available in service worker)
  // In MV3, the service worker cannot access window.ethereum directly.
  // This is a stub; actual submission is always user-initiated from the popup.
  async autoFlush(): Promise<void> {
    console.log("[DATUM] Auto-flush triggered — user must submit from popup");
    await chrome.storage.local.set({ [LAST_FLUSH_KEY]: Date.now() });
    // TODO: Phase 2.8 — implement headless signing when a session key is available
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
