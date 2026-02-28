// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { ContentToBackground, PopupToBackground, OffscreenToBackground } from "@shared/messages";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { ClaimBatch, SerializedClaimBatch } from "@shared/types";

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
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[DATUM] Extension started");
  await initAlarms();
});

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
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses);
    }
  }
  if (alarm.name === ALARM_FLUSH_CLAIMS) {
    await autoFlushViaOffscreen();
  }
});

// -------------------------------------------------------------------------
// Message handler
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground | PopupToBackground | OffscreenToBackground, _sender, sendResponse) => {
    if (msg.type === "OFFSCREEN_SUBMIT_RESULT") {
      handleOffscreenResult(msg);
      sendResponse({ ok: true });
      return false;
    }
    handleMessage(msg as ContentToBackground | PopupToBackground)
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
      const cached = await campaignPoller.getCached();
      return { campaigns: cached };
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
// Offscreen document management (Phase 2.8 auto-submit)
// -------------------------------------------------------------------------

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
// Stores the last auto-flush result for display in popup
const AUTO_FLUSH_RESULT_KEY = "lastAutoFlushResult";

function handleOffscreenResult(msg: OffscreenToBackground) {
  const result = {
    settledCount: msg.settledCount,
    rejectedCount: msg.rejectedCount,
    error: msg.error,
    timestamp: Date.now(),
  };
  chrome.storage.local.set({ [AUTO_FLUSH_RESULT_KEY]: result });
  if (msg.error) {
    console.error("[DATUM] Auto-flush error:", msg.error);
  } else {
    console.log(`[DATUM] Auto-flush: settled=${msg.settledCount} rejected=${msg.rejectedCount}`);
  }
  // Close offscreen document after result received
  closeOffscreen();
}

async function autoFlushViaOffscreen() {
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

    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    if (!userAddress) {
      console.log("[DATUM] Auto-flush skipped — no connected wallet");
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

    // Create offscreen document and send submit request
    // Mutex is released by handleOffscreenResult (via closeOffscreen) or on error
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_SUBMIT",
      userAddress,
      batches: serializeBatches(batches),
      contractAddresses: settings.contractAddresses,
      rpcUrl: settings.rpcUrl,
    });

    // Safety timeout: if offscreen crashes without sending OFFSCREEN_SUBMIT_RESULT,
    // the mutex would stay held until the 5-min staleness timeout. Force cleanup after 2 min.
    setTimeout(() => {
      chrome.storage.local.get("submitting").then((stored) => {
        if (stored.submitting) {
          console.warn("[DATUM] Auto-flush safety timeout — forcing mutex release");
          closeOffscreen();
        }
      });
    }, 120_000);
  } catch (err) {
    console.error("[DATUM] autoFlushViaOffscreen error:", err);
    await claimQueue.releaseMutex();
    closeOffscreen();
  }
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: "Auto-submit claim signing via wallet extension",
    });
  }
}

function closeOffscreen() {
  chrome.offscreen.closeDocument?.().catch(() => {
    // Document may already be closed
  });
  claimQueue.releaseMutex();
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
