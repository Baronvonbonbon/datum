// Builds claims from impressions/clicks/actions, maintaining per-(user, campaign, actionType) hash chains.
// Alpha-3 multi-pricing: uses 9-field Blake2-256 preimage.
// Hash preimage: (campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousHash)

import { solidityPacked, ZeroHash, zeroPadValue, toBeHex } from "ethers";
import { blake2b } from "@noble/hashes/blake2.js";
import { Claim, ClaimChainState } from "@shared/types";
import { generateZKProof } from "./zkProof";
import { getUserSecret, computeWindowId } from "./poseidon";

const WINDOW_BLOCKS = 14400; // 24h at 6s/block
const LAST_BLOCK_KEY = "pollLastBlock";
const ZK_EMPTY: string[] = new Array(8).fill(ZeroHash);
const SIG_EMPTY: string[] = [ZeroHash, ZeroHash, ZeroHash];

/** Parse a 65-byte ECDSA signature hex into bytes32[3] = [r, s, v_as_bytes32]. */
function parseSigToArray(sig: string): string[] {
  if (Array.isArray(sig)) return sig as string[];
  if (!sig || sig === "0x" || sig.length < 132) return SIG_EMPTY;
  const hex = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (hex.length < 130) return SIG_EMPTY;
  const r = "0x" + hex.slice(0, 64);
  const s = "0x" + hex.slice(64, 128);
  const v = parseInt(hex.slice(128, 130), 16);
  return [r, s, "0x" + v.toString(16).padStart(64, "0")];
}

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

/** Convert uint256 nonce to bytes32 hex string (for clickSessionHash field in type-1 claims). */
function nonceToBytes32(nonce: bigint): string {
  return zeroPadValue(toBeHex(nonce), 32);
}

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
  /**
   * Build and queue a type-0 (view/CPM) claim from an impression event.
   * Returns the impressionNonce (bytes32) so the click handler can reference it.
   */
  async onImpression(msg: {
    campaignId: string;
    url: string;
    category: string;
    publisherAddress: string;
    clearingCpmPlanck?: string; // auction-determined clearing CPM (falls back to viewBid)
  }): Promise<string | null> {
    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    if (!userAddress) {
      console.warn("[DATUM] Impression dropped: no connectedAddress in storage. Unlock wallet first.");
      return null;
    }

    let impressionNonce: string | null = null;

    // Serialize per-(user, campaign, actionType) to prevent nonce race from concurrent tabs
    const lockKey = `${userAddress}:${msg.campaignId}:0`;
    await withLock(lockKey, async () => {
      const campaignId = BigInt(msg.campaignId);

      // Fetch viewBid from cached campaigns
      const cached = await chrome.storage.local.get("activeCampaigns");
      const campaigns = cached.activeCampaigns ?? [];
      const campaign = campaigns.find((c: { id: string }) => c.id === msg.campaignId);
      if (!campaign) {
        console.warn(`[DATUM] Impression dropped: campaign ${msg.campaignId} not in activeCampaigns cache`);
        return;
      }

      // Validate publisher address before touching chain state.
      // A zero/missing/mismatched publisher causes settlement rejection, permanently
      // corrupting the hash chain for this (user, campaign, actionType) triple.
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

      const chainState = await getChainState(userAddress, msg.campaignId, 0);
      console.log(`[DATUM] onImpression: campaign=${msg.campaignId} chainState.lastNonce=${chainState.lastNonce} chainState.lastClaimHash=${chainState.lastClaimHash.slice(0, 12)}…`);

      const eventCount = 1n;
      // Use auction clearing CPM if provided, otherwise fall back to viewBid
      const ratePlanck = msg.clearingCpmPlanck
        ? BigInt(msg.clearingCpmPlanck)
        : BigInt(campaign.viewBid ?? "0");
      const nonce = BigInt(chainState.lastNonce + 1);
      const previousClaimHash =
        chainState.lastNonce === 0 ? ZeroHash : chainState.lastClaimHash;

      // For type-0 (view) claims: clickSessionHash = ZeroHash
      const clickSessionHash = ZeroHash;

      // Blake2-256 on PolkaVM; 9-field preimage matches DatumClaimValidator.validateClaim():
      // (campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousHash)
      const claimHash = blake2Hash(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [
          campaignId,
          msg.publisherAddress,
          userAddress,
          eventCount,
          ratePlanck,
          0,               // actionType = 0 (view)
          clickSessionHash,
          nonce,
          previousClaimHash,
        ]
      );

      // Generate real Groth16 proof + nullifier if campaign requires it (FP-5)
      let zkProof: string[] = ZK_EMPTY;
      let nullifier = ZeroHash; // bytes32(0) → NullifierRegistry skips check for non-ZK
      if (campaign.requiresZkProof) {
        const userSecret = await getUserSecret();
        const blockStored = await chrome.storage.local.get(LAST_BLOCK_KEY);
        const lastBlock: number = blockStored[LAST_BLOCK_KEY] ?? 0;
        const windowId = computeWindowId(lastBlock, WINDOW_BLOCKS);
        const zk = await generateZKProof(claimHash, eventCount, nonce, userSecret, campaignId, windowId);
        zkProof = zk.proofArray;
        nullifier = zk.nullifier;
      }

      const claim: Claim = {
        campaignId,
        publisher: msg.publisherAddress,
        eventCount,
        ratePlanck,
        actionType: 0,
        clickSessionHash,
        nonce,
        previousClaimHash,
        claimHash,
        zkProof,
        nullifier,
        actionSig: SIG_EMPTY,
      };

      // Persist updated chain state
      await setChainState(userAddress, msg.campaignId, 0, {
        userAddress,
        campaignId: msg.campaignId,
        actionType: 0,
        lastNonce: Number(nonce),
        lastClaimHash: claimHash,
      });

      // Append claim to queue
      await appendToQueue(claim, userAddress);
      console.log(`[DATUM] View claim queued: campaign=${msg.campaignId} nonce=${nonce} prevHash=${previousClaimHash.slice(0, 12)}… claimHash=${claimHash.slice(0, 12)}… user=${userAddress.slice(0, 10)}…`);

      // Return the impression nonce as bytes32 so click handler can reference this session
      impressionNonce = nonceToBytes32(nonce);
    });

    return impressionNonce;
  },

  /**
   * Build and queue a type-1 (click/CPC) claim.
   * Called by clickHandler after the relay records the click session on-chain.
   *
   * @param impressionNonce - bytes32 nonce from the original impression (clickSessionHash field)
   */
  async onClick(msg: {
    campaignId: string;
    publisherAddress: string;
    impressionNonce: string; // bytes32 from the corresponding view impression
    ratePlanck: string;      // click pot ratePlanck
  }): Promise<void> {
    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    if (!userAddress) {
      console.warn("[DATUM] Click claim dropped: no connectedAddress in storage.");
      return;
    }

    const lockKey = `${userAddress}:${msg.campaignId}:1`;
    await withLock(lockKey, async () => {
      const campaignId = BigInt(msg.campaignId);
      const chainState = await getChainState(userAddress, msg.campaignId, 1);

      const eventCount = 1n;
      const ratePlanck = BigInt(msg.ratePlanck);
      const nonce = BigInt(chainState.lastNonce + 1);
      const previousClaimHash = chainState.lastNonce === 0 ? ZeroHash : chainState.lastClaimHash;
      const clickSessionHash = msg.impressionNonce; // bytes32 impressionNonce

      const claimHash = blake2Hash(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [campaignId, msg.publisherAddress, userAddress, eventCount, ratePlanck, 1, clickSessionHash, nonce, previousClaimHash]
      );

      const claim: Claim = {
        campaignId,
        publisher: msg.publisherAddress,
        eventCount,
        ratePlanck,
        actionType: 1,
        clickSessionHash,
        nonce,
        previousClaimHash,
        claimHash,
        zkProof: ZK_EMPTY,
        nullifier: ZeroHash,
        actionSig: SIG_EMPTY,
      };

      await setChainState(userAddress, msg.campaignId, 1, {
        userAddress,
        campaignId: msg.campaignId,
        actionType: 1,
        lastNonce: Number(nonce),
        lastClaimHash: claimHash,
      });

      await appendToQueue(claim, userAddress);
      console.log(`[DATUM] Click claim queued: campaign=${msg.campaignId} nonce=${nonce} session=${clickSessionHash.slice(0, 12)}…`);
    });
  },

  /**
   * Build and queue a type-2 (remote-action/CPA) claim.
   * Called by actionHandler after fetching the verifier signature from the advertiser backend.
   *
   * @param actionSig - 65-byte EIP-191 signature from the pot's actionVerifier EOA
   */
  async onRemoteAction(msg: {
    campaignId: string;
    publisherAddress: string;
    ratePlanck: string;  // remote-action pot ratePlanck
    actionSig: string;   // 65-byte hex signature from actionVerifier
  }): Promise<void> {
    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    if (!userAddress) {
      console.warn("[DATUM] Remote action claim dropped: no connectedAddress in storage.");
      return;
    }

    const lockKey = `${userAddress}:${msg.campaignId}:2`;
    await withLock(lockKey, async () => {
      const campaignId = BigInt(msg.campaignId);
      const chainState = await getChainState(userAddress, msg.campaignId, 2);

      const eventCount = 1n;
      const ratePlanck = BigInt(msg.ratePlanck);
      const nonce = BigInt(chainState.lastNonce + 1);
      const previousClaimHash = chainState.lastNonce === 0 ? ZeroHash : chainState.lastClaimHash;

      const claimHash = blake2Hash(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [campaignId, msg.publisherAddress, userAddress, eventCount, ratePlanck, 2, ZeroHash, nonce, previousClaimHash]
      );

      const claim: Claim = {
        campaignId,
        publisher: msg.publisherAddress,
        eventCount,
        ratePlanck,
        actionType: 2,
        clickSessionHash: ZeroHash,
        nonce,
        previousClaimHash,
        claimHash,
        zkProof: ZK_EMPTY,
        nullifier: ZeroHash,
        actionSig: parseSigToArray(msg.actionSig),
      };

      await setChainState(userAddress, msg.campaignId, 2, {
        userAddress,
        campaignId: msg.campaignId,
        actionType: 2,
        lastNonce: Number(nonce),
        lastClaimHash: claimHash,
      });

      await appendToQueue(claim, userAddress);
      console.log(`[DATUM] Remote action claim queued: campaign=${msg.campaignId} nonce=${nonce}`);
    });
  },

  // Re-sync chain state from on-chain after a nonce mismatch
  async syncFromChain(
    userAddress: string,
    campaignId: string,
    onChainNonce: number,
    onChainHash: string,
    actionType: number = 0
  ): Promise<void> {
    await setChainState(userAddress, campaignId, actionType, {
      userAddress,
      campaignId,
      actionType,
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

async function getChainState(userAddress: string, campaignId: string, actionType: number): Promise<ClaimChainState> {
  const key = `${CHAIN_STATE_PREFIX}${userAddress}:${campaignId}:${actionType}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? { userAddress, campaignId, actionType, lastNonce: 0, lastClaimHash: ZeroHash };
}

async function setChainState(
  userAddress: string,
  campaignId: string,
  actionType: number,
  state: ClaimChainState
): Promise<void> {
  const key = `${CHAIN_STATE_PREFIX}${userAddress}:${campaignId}:${actionType}`;
  await chrome.storage.local.set({ [key]: state });
}

// -------------------------------------------------------------------------
// Queue helpers (serialized — bigints stored as strings)
// -------------------------------------------------------------------------

interface SerializedClaim {
  campaignId: string;
  publisher: string;
  eventCount: string;
  ratePlanck: string;
  actionType: string;
  clickSessionHash: string;
  nonce: string;
  previousClaimHash: string;
  claimHash: string;
  zkProof: string[];
  nullifier: string;
  actionSig: string[];
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
    eventCount: claim.eventCount.toString(),
    ratePlanck: claim.ratePlanck.toString(),
    actionType: claim.actionType.toString(),
    clickSessionHash: claim.clickSessionHash,
    nonce: claim.nonce.toString(),
    previousClaimHash: claim.previousClaimHash,
    claimHash: claim.claimHash,
    zkProof: claim.zkProof,
    nullifier: claim.nullifier,
    actionSig: claim.actionSig,
    userAddress,
  };
}
