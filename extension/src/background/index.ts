// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { DEFAULT_SETTINGS } from "@shared/networks";

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

  // Campaign polling: always active (read-only, no wallet needed)
  await chrome.alarms.create(ALARM_POLL_CAMPAIGNS, {
    periodInMinutes: 5,
    delayInMinutes: 0,
  });

  // Claim flushing: only when auto-submit is enabled
  if (settings.autoSubmit) {
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
    await claimQueue.autoFlush();
  }
});

// -------------------------------------------------------------------------
// Message handler
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground | PopupToBackground, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch((err) => {
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

// ClaimBatch contains bigints — serialize for chrome message passing (JSON)
function serializeBatches(
  batches: import("@shared/types").ClaimBatch[]
): Array<{
  user: string;
  campaignId: string;
  claims: Array<{
    campaignId: string;
    publisher: string;
    impressionCount: string;
    clearingCpmPlanck: string;
    nonce: string;
    previousClaimHash: string;
    claimHash: string;
    zkProof: string;
  }>;
}> {
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
