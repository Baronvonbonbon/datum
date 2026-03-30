// Behavior hash chain — per-(userAddress, campaignId) append-only chain.
// Each engagement event is hashed into the chain for future ZK verification.
// Alpha-2: Uses Blake2-256 to match on-chain hash semantics.

import { solidityPacked, ZeroHash } from "ethers";
import { blake2b } from "@noble/hashes/blake2.js";
import { BehaviorChainState, EngagementEvent } from "@shared/types";

function blake2Hash(types: string[], values: unknown[]): string {
  const packed = solidityPacked(types, values);
  const h = packed.startsWith("0x") ? packed.slice(2) : packed;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const hash = blake2b(bytes, { dkLen: 32 });
  return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

const CHAIN_KEY_PREFIX = "behaviorChain:";

/** Append an engagement event to the behavior chain */
export async function appendEvent(
  userAddress: string,
  event: EngagementEvent,
): Promise<BehaviorChainState> {
  const state = await getChainState(userAddress, event.campaignId);

  // Hash: blake2b(previousHash, campaignId, dwellMs, scrollDepthPct, tabFocusMs, viewableMs, iabViewable, timestamp)
  const newHash = blake2Hash(
    ["bytes32", "string", "uint256", "uint256", "uint256", "uint256", "bool", "uint256"],
    [
      state.headHash,
      event.campaignId,
      event.dwellMs,
      event.scrollDepthPct,
      event.tabFocusMs,
      event.viewableMs,
      event.iabViewable,
      event.timestamp,
    ],
  );

  const updated: BehaviorChainState = {
    userAddress,
    campaignId: event.campaignId,
    headHash: newHash,
    eventCount: state.eventCount + 1,
    cumulativeDwellMs: state.cumulativeDwellMs + event.dwellMs,
    cumulativeViewableMs: state.cumulativeViewableMs + event.viewableMs,
    iabViewableCount: state.iabViewableCount + (event.iabViewable ? 1 : 0),
  };

  await setChainState(userAddress, event.campaignId, updated);
  return updated;
}

/** Get chain state for a user/campaign pair */
export async function getChainState(
  userAddress: string,
  campaignId: string,
): Promise<BehaviorChainState> {
  const key = `${CHAIN_KEY_PREFIX}${userAddress}:${campaignId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? {
    userAddress,
    campaignId,
    headHash: ZeroHash,
    eventCount: 0,
    cumulativeDwellMs: 0,
    cumulativeViewableMs: 0,
    iabViewableCount: 0,
  };
}

/** Get all chain states for a user (for UI display) */
export async function getAllChainStates(userAddress: string): Promise<BehaviorChainState[]> {
  const all = await chrome.storage.local.get(null);
  const prefix = `${CHAIN_KEY_PREFIX}${userAddress}:`;
  const states: BehaviorChainState[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      states.push(value as BehaviorChainState);
    }
  }
  return states;
}

async function setChainState(
  userAddress: string,
  campaignId: string,
  state: BehaviorChainState,
): Promise<void> {
  const key = `${CHAIN_KEY_PREFIX}${userAddress}:${campaignId}`;
  await chrome.storage.local.set({ [key]: state });
}

/**
 * UB-2: Clean up behavior chain storage for campaigns that are no longer active.
 * Called during campaign poll alarm to prevent unbounded storage growth.
 * Returns the number of chain states removed.
 */
export async function cleanupTerminalChains(activeCampaignIds: Set<string>): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CHAIN_KEY_PREFIX)) continue;
    // Key format: behaviorChain:{address}:{campaignId}
    const parts = key.slice(CHAIN_KEY_PREFIX.length).split(":");
    const campaignId = parts[parts.length - 1];
    if (campaignId && !activeCampaignIds.has(campaignId)) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  return keysToRemove.length;
}
