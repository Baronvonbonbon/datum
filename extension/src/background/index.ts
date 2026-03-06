// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { Wallet, JsonRpcProvider, Contract } from "ethers";
import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { interestProfile } from "./interestProfile";
import { selectCampaign } from "./campaignMatcher";
import { requestPublisherAttestation } from "./publisherAttestation";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { ClaimBatch, SerializedClaimBatch } from "@shared/types";
import DatumSettlementAbi from "@shared/abis/DatumSettlement.json";

// -------------------------------------------------------------------------
// Alarm names
// -------------------------------------------------------------------------

const ALARM_POLL_CAMPAIGNS = "pollCampaigns";
const ALARM_FLUSH_CLAIMS = "flushClaims";

// -------------------------------------------------------------------------
// Startup: register alarms and restore state
// -------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[DATUM] Extension installed/updated");
  await initAlarms();
  // Immediate poll — chrome alarms have a minimum 1-min delay
  await immediateInitialPoll();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[DATUM] Extension started");
  await initAlarms();
  await immediateInitialPoll();
});

async function immediateInitialPoll() {
  try {
    let settings = await getSettings();

    // Auto-load deployed addresses if settings have empty contract addresses
    if (!settings.contractAddresses.campaigns) {
      const loaded = await tryLoadDeployedAddresses();
      if (loaded) {
        settings = { ...settings, contractAddresses: { ...settings.contractAddresses, ...loaded } };
        await chrome.storage.local.set({ settings });
        console.log("[DATUM] Auto-loaded deployed contract addresses");
      }
    }

    if (settings.contractAddresses.campaigns) {
      console.log("[DATUM] Running immediate campaign poll...");
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway);
    } else {
      console.log("[DATUM] Skipping initial poll — no campaigns contract address configured");
    }
  } catch (err) {
    console.error("[DATUM] Initial poll failed:", err);
  }
}

/** Try to load deployed-addresses.json from extension bundle (written by deploy script). */
async function tryLoadDeployedAddresses(): Promise<Record<string, string> | null> {
  try {
    const url = chrome.runtime.getURL("deployed-addresses.json");
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const addrs = await resp.json();
    // Map deploy script keys to extension ContractAddresses keys
    return {
      campaigns: addrs.campaigns ?? "",
      publishers: addrs.publishers ?? "",
      governanceVoting: addrs.governanceVoting ?? "",
      governanceRewards: addrs.governanceRewards ?? "",
      settlement: addrs.settlement ?? "",
      relay: addrs.relay ?? "",
    };
  } catch {
    return null;
  }
}

async function initAlarms() {
  const settings = await getSettings();

  // Clear before recreating — chrome.alarms.create throws if name already exists
  await chrome.alarms.clear(ALARM_POLL_CAMPAIGNS);

  // Campaign polling: always active (read-only, no wallet needed)
  await chrome.alarms.create(ALARM_POLL_CAMPAIGNS, {
    periodInMinutes: 5,
    delayInMinutes: 0,
  });

  // Claim flushing: only when auto-submit is enabled
  if (settings.autoSubmit) {
    await chrome.alarms.clear(ALARM_FLUSH_CLAIMS);
    await chrome.alarms.create(ALARM_FLUSH_CLAIMS, {
      periodInMinutes: settings.autoSubmitIntervalMinutes,
    });
  } else {
    await chrome.alarms.clear(ALARM_FLUSH_CLAIMS);
  }
}

// -------------------------------------------------------------------------
// Alarm handler
// -------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_POLL_CAMPAIGNS) {
    const settings = await getSettings();
    if (settings.contractAddresses.campaigns) {
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway);
      // Prune claims for campaigns that are no longer active (withdrawn, terminated, etc.)
      const active = await campaignPoller.getCachedSerialized();
      const activeIds = new Set(active.map((c) => c.id));
      const pruned = await claimQueue.pruneInactiveCampaigns(activeIds);
      if (pruned > 0) console.log(`[DATUM] Pruned ${pruned} stale claims for inactive campaigns`);
    }
  }
  if (alarm.name === ALARM_FLUSH_CLAIMS) {
    await autoFlushDirect();
  }
});

// -------------------------------------------------------------------------
// Message handler
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground | PopupToBackground, _sender, sendResponse) => {
    handleMessage(msg)
      .then(sendResponse)
      .catch((err) => {
        console.error("[DATUM background] message error:", err);
        sendResponse({ error: String(err) });
      });
    return true; // async response
  }
);

async function handleMessage(
  msg: ContentToBackground | PopupToBackground
): Promise<unknown> {
  switch (msg.type) {
    case "IMPRESSION_RECORDED":
      await claimBuilder.onImpression(msg);
      return { ok: true };

    case "GET_ACTIVE_CAMPAIGNS": {
      // Return serialized form — BigInt is not JSON-safe for chrome messaging
      const cached = await campaignPoller.getCachedSerialized();
      return { campaigns: cached };
    }

    case "POLL_CAMPAIGNS": {
      const s = await getSettings();
      if (s.contractAddresses.campaigns) {
        await campaignPoller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway);
        const refreshed = await campaignPoller.getCachedSerialized();
        // Prune stale claims after fresh poll
        const activeIds = new Set(refreshed.map((c) => c.id));
        const pruned = await claimQueue.pruneInactiveCampaigns(activeIds);
        if (pruned > 0) console.log(`[DATUM] Pruned ${pruned} stale claims after manual poll`);
        return { campaigns: refreshed, ok: true };
      }
      return { campaigns: [], error: "No campaigns contract address configured" };
    }

    case "WALLET_CONNECTED": {
      await chrome.storage.local.set({ connectedAddress: msg.address });
      return { ok: true };
    }

    case "WALLET_DISCONNECTED": {
      await chrome.storage.local.remove("connectedAddress");
      return { ok: true };
    }

    case "GET_QUEUE_STATE": {
      const state = await claimQueue.getState();
      return state;
    }

    case "CLEAR_QUEUE": {
      await claimQueue.clear();
      return { ok: true };
    }

    case "SUBMIT_CLAIMS": {
      // Build batches from queue and return them to popup for signing
      const batches = await claimQueue.buildBatches(msg.userAddress);
      return { batches: serializeBatches(batches) };
    }

    case "SIGN_FOR_RELAY": {
      // Build batches for a specific campaign for relay signing
      const allBatches = await claimQueue.buildBatches(msg.userAddress);
      const filtered = allBatches.filter(
        (b) => b.campaignId.toString() === msg.campaignId
      );
      return { batches: serializeBatches(filtered) };
    }

    case "SETTINGS_UPDATED": {
      // Re-configure alarms with new settings
      await initAlarms();
      return { ok: true };
    }

    case "ACQUIRE_MUTEX": {
      const acquired = await claimQueue.acquireMutex();
      return { acquired };
    }

    case "RELEASE_MUTEX": {
      await claimQueue.releaseMutex();
      return { ok: true };
    }

    case "REMOVE_SETTLED_CLAIMS": {
      // Convert serialized nonces (string[]) back to bigint[] per campaign
      const settledNonces = new Map<string, bigint[]>(
        Object.entries(msg.settledNonces).map(([cid, nonces]) => [
          cid,
          nonces.map((n) => BigInt(n)),
        ])
      );
      await claimQueue.removeSettled(msg.userAddress, settledNonces);
      return { ok: true };
    }

    case "SYNC_CHAIN_STATE": {
      await claimBuilder.syncFromChain(
        msg.userAddress,
        msg.campaignId,
        msg.onChainNonce,
        msg.onChainHash
      );
      return { ok: true };
    }

    case "RESET_CHAIN_STATE": {
      // Wipe all chainState:* keys from storage
      const allKeys = await chrome.storage.local.get(null);
      const chainStateKeys = Object.keys(allKeys).filter((k) =>
        k.startsWith("chainState:")
      );
      if (chainStateKeys.length > 0) {
        await chrome.storage.local.remove(chainStateKeys);
      }
      // Also clear the claim queue (claims depend on chain state)
      await claimQueue.clear();
      return { ok: true, cleared: chainStateKeys.length };
    }

    case "UPDATE_INTEREST": {
      await interestProfile.updateProfile(msg.category);
      return { ok: true };
    }

    case "SELECT_CAMPAIGN": {
      const profile = await interestProfile.getProfile();
      const selected = selectCampaign(msg.campaigns, profile, msg.pageCategory);
      return { selected };
    }

    case "GET_INTEREST_PROFILE": {
      const profile = await interestProfile.getProfile();
      return { profile };
    }

    case "RESET_INTEREST_PROFILE": {
      await interestProfile.resetProfile();
      return { ok: true };
    }

    case "REQUEST_PUBLISHER_ATTESTATION": {
      const sig = await requestPublisherAttestation(
        msg.publisherAddress,
        msg.campaignId,
        msg.userAddress,
        msg.firstNonce,
        msg.lastNonce,
        msg.claimCount
      );
      return { signature: sig || undefined };
    }

    default:
      return { error: "unknown message type" };
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return stored.settings ?? DEFAULT_SETTINGS;
}

// -------------------------------------------------------------------------
// Auto-submit: direct signing in background (no offscreen needed)
// -------------------------------------------------------------------------

// Stores the last auto-flush result for display in popup
const AUTO_FLUSH_RESULT_KEY = "lastAutoFlushResult";
// Storage key for the encrypted wallet (must match walletManager.ts)
const WALLET_STORAGE_KEY = "datumEncryptedWallet";
// Storage key for the auto-submit password (set by popup when user opts in)
const AUTO_SUBMIT_KEY_KEY = "autoSubmitKey";

async function autoFlushDirect() {
  const acquired = await claimQueue.acquireMutex();
  if (!acquired) {
    console.log("[DATUM] Auto-flush skipped — submission already in progress");
    return;
  }

  try {
    const settings = await getSettings();
    if (!settings.contractAddresses.settlement || !settings.autoSubmit) {
      await claimQueue.releaseMutex();
      return;
    }

    const stored = await chrome.storage.local.get(["connectedAddress", AUTO_SUBMIT_KEY_KEY]);
    const userAddress: string | undefined = stored.connectedAddress;
    const privateKey: string | undefined = stored[AUTO_SUBMIT_KEY_KEY];

    if (!userAddress || !privateKey) {
      console.log("[DATUM] Auto-flush skipped — no connected wallet or auto-submit key not set");
      await claimQueue.releaseMutex();
      return;
    }

    const batches = await claimQueue.buildBatches(userAddress);
    if (batches.length === 0) {
      await claimQueue.releaseMutex();
      return;
    }

    // Record flush attempt time
    await chrome.storage.local.set({ lastAutoFlush: Date.now() });

    // Sign and submit directly using ethers.Wallet (no DOM needed)
    const provider = new JsonRpcProvider(settings.rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const settlement = new Contract(
      settings.contractAddresses.settlement,
      DatumSettlementAbi.abi,
      wallet
    );

    const contractBatches = batches.map((b) => ({
      user: b.user,
      campaignId: b.campaignId,
      claims: b.claims.map((c) => ({
        campaignId: c.campaignId,
        publisher: c.publisher,
        impressionCount: c.impressionCount,
        clearingCpmPlanck: c.clearingCpmPlanck,
        nonce: c.nonce,
        previousClaimHash: c.previousClaimHash,
        claimHash: c.claimHash,
        zkProof: c.zkProof,
      })),
    }));

    let settledCount = 0;
    let rejectedCount = 0;

    const tx = await settlement.settleClaims(contractBatches);
    const receipt = await tx.wait();

    if (receipt?.logs) {
      const iface = settlement.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "ClaimSettled") settledCount++;
          else if (parsed?.name === "ClaimRejected") rejectedCount++;
        } catch {
          // log from different contract
        }
      }
    }

    // Remove settled claims from queue
    if (settledCount > 0) {
      const settledNonces = new Map<string, bigint[]>();
      for (const b of batches) {
        const cid = b.campaignId.toString();
        settledNonces.set(cid, b.claims.map((c) => c.nonce));
      }
      await claimQueue.removeSettled(userAddress, settledNonces);
    }

    const result = {
      settledCount,
      rejectedCount,
      timestamp: Date.now(),
    };
    await chrome.storage.local.set({ [AUTO_FLUSH_RESULT_KEY]: result });
    console.log(`[DATUM] Auto-flush: settled=${settledCount} rejected=${rejectedCount}`);
  } catch (err) {
    console.error("[DATUM] Auto-flush error:", err);
    const result = {
      settledCount: 0,
      rejectedCount: 0,
      error: String(err),
      timestamp: Date.now(),
    };
    await chrome.storage.local.set({ [AUTO_FLUSH_RESULT_KEY]: result });
  } finally {
    await claimQueue.releaseMutex();
  }
}

// ClaimBatch contains bigints — serialize for chrome message passing (JSON)
function serializeBatches(batches: ClaimBatch[]): SerializedClaimBatch[] {
  return batches.map((b) => ({
    user: b.user,
    campaignId: b.campaignId.toString(),
    claims: b.claims.map((c) => ({
      campaignId: c.campaignId.toString(),
      publisher: c.publisher,
      impressionCount: c.impressionCount.toString(),
      clearingCpmPlanck: c.clearingCpmPlanck.toString(),
      nonce: c.nonce.toString(),
      previousClaimHash: c.previousClaimHash,
      claimHash: c.claimHash,
      zkProof: c.zkProof,
    })),
  }));
}
