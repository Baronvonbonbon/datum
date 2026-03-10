// Builds claims from impressions, maintaining per-(user, campaign) hash chains.

import { keccak256, solidityPackedKeccak256, ZeroHash } from "ethers";
import { Claim, ClaimChainState, Impression } from "@shared/types";

const CHAIN_STATE_PREFIX = "chainState:";
const QUEUE_KEY = "claimQueue";

// Per-(user, campaign) mutex to prevent nonce race conditions
const locks = new Map<string, Promise<void>>();
function withLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  return next;
}

export const claimBuilder = {
  async onImpression(msg: {
    campaignId: string;
    url: string;
    category: string;
    publisherAddress: string;
    clearingCpmPlanck?: string; // auction-determined clearing CPM
  }): Promise<void> {
    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    if (!userAddress) return; // no wallet connected

    // Serialize per-(user, campaign) to prevent nonce race from concurrent tabs
    const lockKey = `${userAddress}:${msg.campaignId}`;
    await withLock(lockKey, async () => {
      const campaignId = BigInt(msg.campaignId);
      const chainState = await getChainState(userAddress, msg.campaignId);

      // Fetch bidCpmPlanck from cached campaigns
      const cached = await chrome.storage.local.get("activeCampaigns");
      const campaigns = cached.activeCampaigns ?? [];
      const campaign = campaigns.find((c: { id: string }) => c.id === msg.campaignId);
      if (!campaign) return; // campaign no longer active

      const impressionCount = 1n;
      // Use auction clearing CPM if provided, otherwise fall back to bid CPM
      const clearingCpmPlanck = msg.clearingCpmPlanck
        ? BigInt(msg.clearingCpmPlanck)
        : BigInt(campaign.bidCpmPlanck);
      const nonce = BigInt(chainState.lastNonce + 1);
      const previousClaimHash =
        chainState.lastNonce === 0 ? ZeroHash : chainState.lastClaimHash;

      const claimHash = solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [
          campaignId,
          msg.publisherAddress,
          userAddress,
          impressionCount,
          clearingCpmPlanck,
          nonce,
          previousClaimHash,
        ]
      );

      const claim: Claim = {
        campaignId,
        publisher: msg.publisherAddress,
        impressionCount,
        clearingCpmPlanck,
        nonce,
        previousClaimHash,
        claimHash,
        zkProof: "0x",
      };

      // Persist updated chain state
      await setChainState(userAddress, msg.campaignId, {
        userAddress,
        campaignId: msg.campaignId,
        lastNonce: Number(nonce),
        lastClaimHash: claimHash,
      });

      // Append claim to queue
      await appendToQueue(claim, userAddress);
    });
  },

  // Re-sync chain state from on-chain after a nonce mismatch
  async syncFromChain(
    userAddress: string,
    campaignId: string,
    onChainNonce: number,
    onChainHash: string
  ): Promise<void> {
    await setChainState(userAddress, campaignId, {
      userAddress,
      campaignId,
      lastNonce: onChainNonce,
      lastClaimHash: onChainHash,
    });
    // Clear queued claims for this campaign (they're stale)
    await clearQueueForCampaign(userAddress, campaignId);
  },
};

// -------------------------------------------------------------------------
// Chain state helpers
// -------------------------------------------------------------------------

async function getChainState(userAddress: string, campaignId: string): Promise<ClaimChainState> {
  const key = `${CHAIN_STATE_PREFIX}${userAddress}:${campaignId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? { userAddress, campaignId, lastNonce: 0, lastClaimHash: ZeroHash };
}

async function setChainState(
  userAddress: string,
  campaignId: string,
  state: ClaimChainState
): Promise<void> {
  const key = `${CHAIN_STATE_PREFIX}${userAddress}:${campaignId}`;
  await chrome.storage.local.set({ [key]: state });
}

// -------------------------------------------------------------------------
// Queue helpers (serialized — bigints stored as strings)
// -------------------------------------------------------------------------

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

async function appendToQueue(claim: Claim, userAddress: string): Promise<void> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];
  queue.push(serializeClaim(claim, userAddress));
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function clearQueueForCampaign(userAddress: string, campaignId: string): Promise<void> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: SerializedClaim[] = stored[QUEUE_KEY] ?? [];
  const filtered = queue.filter(
    (c) => !(c.userAddress === userAddress && c.campaignId === campaignId)
  );
  await chrome.storage.local.set({ [QUEUE_KEY]: filtered });
}

function serializeClaim(claim: Claim, userAddress: string): SerializedClaim {
  return {
    campaignId: claim.campaignId.toString(),
    publisher: claim.publisher,
    impressionCount: claim.impressionCount.toString(),
    clearingCpmPlanck: claim.clearingCpmPlanck.toString(),
    nonce: claim.nonce.toString(),
    previousClaimHash: claim.previousClaimHash,
    claimHash: claim.claimHash,
    zkProof: claim.zkProof,
    userAddress,
  };
}
