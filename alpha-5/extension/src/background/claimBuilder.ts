// Builds claims from impressions/clicks/actions, maintaining per-(user, campaign, actionType) hash chains.
// Alpha-5 EVM: uses keccak256 (9-field preimage).
// Hash preimage: (campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousHash)
// L-2: claim hash uses abi.encode (32-byte aligned) — must match DatumClaimValidator on-chain.

import { ZeroHash } from "ethers";
import { Claim, ClaimChainState } from "@shared/types";
// Canonical claim-hash + helpers live in claimCore (shared with the demo daemon)
// so the preimage schema can never drift between consumers again.
import { computeClaimHash, ZK_EMPTY, SIG_EMPTY, nonceToBytes32, parseSigToArray } from "./claimCore";

const CHAIN_STATE_PREFIX = "chainState:";
const QUEUE_KEY = "claimQueue";

// ZK proof generation is injected, not imported, so this module stays free of
// `./zkProof` (→ snarkjs) and `./poseidon` (→ circomlib). That lets the demo
// daemon import the *real* claimBuilder instead of re-inlining claim-building
// (the source of three settlement-breaking drifts — see claimCore.ts). The
// service worker wires the snarkjs-backed prover via setProveZk() at startup;
// the demo leaves it null, so ZK-required campaigns simply get an empty proof
// (the demo only serves non-ZK campaigns).
export interface ProveZkArgs {
  claimHash: string;
  eventCount: bigint;
  nonce: bigint;
  campaignId: bigint;
}
export type ProveZkFn = (args: ProveZkArgs) => Promise<{ proofArray: string[]; nullifier: string }>;

let _proveZk: ProveZkFn | null = null;
/** Install the snarkjs-backed ZK prover (service worker only). */
export function setProveZk(fn: ProveZkFn | null): void {
  _proveZk = fn;
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

      // Path A: stakeRootUsed is part of the preimage so wallets can target a
      // specific stake-root epoch. ZeroHash here = no stake gate enforced for
      // this claim. The ZK proof generator overwrites it when staking is used.
      let stakeRootUsed = ZeroHash;

      // keccak256; 10-field preimage matches DatumClaimValidator.validateClaim():
      // (campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousHash, stakeRootUsed)
      const claimHash = computeClaimHash({
        campaignId, publisher: msg.publisherAddress, user: userAddress,
        eventCount, ratePlanck, actionType: 0, clickSessionHash, nonce, previousClaimHash, stakeRootUsed,
      });

      // Generate real Groth16 proof + nullifier if campaign requires it (FP-5).
      // Delegated to the injected prover so this module stays snarkjs-free.
      let zkProof: string[] = ZK_EMPTY;
      let nullifier = ZeroHash; // bytes32(0) → NullifierRegistry skips check for non-ZK
      if (campaign.requiresZkProof && _proveZk) {
        const zk = await _proveZk({ claimHash, eventCount, nonce, campaignId });
        zkProof = zk.proofArray;
        nullifier = zk.nullifier;
      } else if (campaign.requiresZkProof && !_proveZk) {
        console.warn(`[DATUM] Campaign ${msg.campaignId} requires a ZK proof but no prover is installed — submitting empty proof (will be rejected on-chain).`);
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
        stakeRootUsed,
        actionSig: SIG_EMPTY,
        powNonce: ZeroHash, // #5: extension solves PoW lazily at submit time
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

      const stakeRootUsed = ZeroHash; // click claims don't use ZK stake gate
      const claimHash = computeClaimHash({
        campaignId, publisher: msg.publisherAddress, user: userAddress,
        eventCount, ratePlanck, actionType: 1, clickSessionHash, nonce, previousClaimHash, stakeRootUsed,
      });

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
        stakeRootUsed,
        actionSig: SIG_EMPTY,
        powNonce: ZeroHash, // #5: extension solves PoW lazily at submit time
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

      const stakeRootUsed = ZeroHash; // remote-action claims don't use ZK stake gate
      const claimHash = computeClaimHash({
        campaignId, publisher: msg.publisherAddress, user: userAddress,
        eventCount, ratePlanck, actionType: 2, clickSessionHash: ZeroHash, nonce, previousClaimHash, stakeRootUsed,
      });

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
        stakeRootUsed,
        actionSig: parseSigToArray(msg.actionSig),
        powNonce: ZeroHash, // #5: extension solves PoW lazily at submit time
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
  powNonce: string;
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
    powNonce: claim.powNonce,
    userAddress,
  };
}
