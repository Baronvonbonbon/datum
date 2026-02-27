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

    case "SUBMIT_CLAIMS":
    case "SIGN_FOR_RELAY":
      // These require a signer — popup handles the wallet interaction
      // and calls settleClaims directly via walletBridge in popup context.
      return { ok: true, note: "handled in popup" };

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
