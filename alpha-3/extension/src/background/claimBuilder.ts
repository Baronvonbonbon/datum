// Builds claims from impressions, maintaining per-(user, campaign) hash chains.
// Alpha-2: Uses Blake2-256 on PolkaVM (keccak256 fallback for local Hardhat EVM).
// Hash preimage: (campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)

import { solidityPacked, ZeroHash } from "ethers";
import { blake2b } from "@noble/hashes/blake2.js";
import { Claim, ClaimChainState, Impression } from "@shared/types";
import { generateZKProof } from "./zkProof";

/** Blake2-256 hash of ABI-packed values. Matches ISystem(0x900).hashBlake256() on PolkaVM. */
function blake2Hash(types: string[], values: unknown[]): string {
  const packed = solidityPacked(types, values);
  const bytes = hexToBytes(packed);
  const hash = blake2b(bytes, { dkLen: 32 });
  return "0x" + bytesToHex(hash);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

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
    if (!userAddress) {
      console.warn("[DATUM] Impression dropped: no connectedAddress in storage. Unlock wallet first.");
      return;
    }

    // Serialize per-(user, campaign) to prevent nonce race from concurrent tabs
    const lockKey = `${userAddress}:${msg.campaignId}`;
    await withLock(lockKey, async () => {
      const campaignId = BigInt(msg.campaignId);

      // Fetch bidCpmPlanck from cached campaigns
      const cached = await chrome.storage.local.get("activeCampaigns");
      const campaigns = cached.activeCampaigns ?? [];
      const campaign = campaigns.find((c: { id: string }) => c.id === msg.campaignId);
      if (!campaign) {
        console.warn(`[DATUM] Impression dropped: campaign ${msg.campaignId} not in activeCampaigns cache`);
        return;
      }

      // Validate publisher address before touching chain state.
      // A zero/missing/mismatched publisher causes settlement rejection, permanently
      // corrupting the hash chain for this (user, campaign) pair.
      const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
      const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/i;
      if (!msg.publisherAddress || !ETH_ADDR_RE.test(msg.publisherAddress) ||
          msg.publisherAddress.toLowerCase() === ZERO_ADDRESS) {
        console.warn(`[DATUM] Impression dropped: invalid publisherAddress "${msg.publisherAddress}"`);
        return;
      }
      if (campaign.publisher && campaign.publisher !== ZERO_ADDRESS &&
          campaign.publisher.toLowerCase() !== msg.publisherAddress.toLowerCase()) {
        console.warn(`[DATUM] Impression dropped: publisher mismatch for campaign ${msg.campaignId} (expected ${campaign.publisher}, got ${msg.publisherAddress})`);
        return;
      }

      const chainState = await getChainState(userAddress, msg.campaignId);

      const impressionCount = 1n;
      // Use auction clearing CPM if provided, otherwise fall back to bid CPM
      const clearingCpmPlanck = msg.clearingCpmPlanck
        ? BigInt(msg.clearingCpmPlanck)
        : BigInt(campaign.bidCpmPlanck);
      const nonce = BigInt(chainState.lastNonce + 1);
      const previousClaimHash =
        chainState.lastNonce === 0 ? ZeroHash : chainState.lastClaimHash;

      // Blake2-256 on PolkaVM; matches Settlement._validateClaim() hash order:
      // (campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)
      const claimHash = blake2Hash(
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

      // Generate real Groth16 proof if campaign requires it (impression.circom, BN254)
      const zkProof = campaign.requiresZkProof
        ? await generateZKProof(claimHash, impressionCount, nonce)
        : "0x";

      const claim: Claim = {
        campaignId,
        publisher: msg.publisherAddress,
        impressionCount,
        clearingCpmPlanck,
        nonce,
        previousClaimHash,
        claimHash,
        zkProof,
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
      console.log(`[DATUM] Claim queued: campaign=${msg.campaignId} nonce=${nonce} user=${userAddress}`);
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
