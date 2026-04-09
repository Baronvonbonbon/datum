/**
 * extensionDaemon.ts — In-page replica of the DATUM extension background.
 *
 * Installs the chrome shim, then registers the message handlers the popup
 * components expect. Sources directly from the extension's background modules
 * so there is no second codebase to maintain.
 *
 * Intentionally omits claimBuilder (requires snarkjs) — the claim queue
 * reads/writes work fine without it; impression recording just isn't hooked
 * up on the demo page.
 */

import { installChromeShim } from "./chromeShim";

// Install shim synchronously at module evaluation time.
// Must happen before any chrome.* call at runtime.
installChromeShim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

// ── Lazy module references (populated by startDaemon) ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _poller: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _queue: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _prefs: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _interest: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _attest: any = null;

let _mutexHeld = false;

// ── Message handler ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMessage(msg: any): Promise<unknown> {
  switch (msg.type) {
    // ── Campaigns ──────────────────────────────────────────────────────────
    case "GET_ACTIVE_CAMPAIGNS": {
      const cached = _poller ? await _poller.getCachedSerialized() : [];
      return { campaigns: cached };
    }

    case "POLL_CAMPAIGNS": {
      if (_poller) {
        const stored = await chrome.storage.local.get("settings");
        const s = stored.settings;
        if (s?.rpcUrl && s?.contractAddresses?.campaigns) {
          _poller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway).catch(console.warn);
        }
      }
      return { ok: true };
    }

    // ── Claim queue ────────────────────────────────────────────────────────
    case "GET_QUEUE_STATE": {
      if (!_queue) return { pendingCount: 0, byUser: {}, lastFlush: null };
      return _queue.getState();
    }

    case "SUBMIT_CLAIMS": {
      if (!_queue) return { batches: [] };
      return { batches: await _queue.getForSubmission(msg.userAddress) };
    }

    case "SUBMIT_CAMPAIGN_CLAIMS": {
      if (!_queue) return { batches: [] };
      return { batches: await _queue.getForCampaign(msg.userAddress, msg.campaignId) };
    }

    case "DISCARD_CAMPAIGN_CLAIMS": {
      if (_queue) await _queue.discardCampaign(msg.userAddress, msg.campaignId);
      return { ok: true };
    }

    case "DISCARD_REJECTED_CLAIMS": {
      if (_queue) await _queue.discardRejected(msg.userAddress);
      return { ok: true };
    }

    case "REMOVE_SETTLED_CLAIMS": {
      if (_queue) await _queue.removeSettled(msg.userAddress, msg.settledNonces ?? {});
      return { ok: true };
    }

    case "CLEAR_QUEUE": {
      if (_queue) await _queue.clear();
      return { ok: true };
    }

    // ── Mutex (single-tab — no real contention) ────────────────────────────
    case "ACQUIRE_MUTEX": {
      if (_mutexHeld) return { acquired: false };
      _mutexHeld = true;
      return { acquired: true };
    }

    case "RELEASE_MUTEX": {
      _mutexHeld = false;
      return { ok: true };
    }

    // ── User preferences ───────────────────────────────────────────────────
    case "GET_USER_PREFERENCES": {
      const preferences = _prefs ? await _prefs.getPreferences() : defaultPreferences();
      return { preferences };
    }

    case "UPDATE_USER_PREFERENCES": {
      if (_prefs) await _prefs.updatePreferences(msg.preferences);
      return { preferences: msg.preferences };
    }

    case "BLOCK_CAMPAIGN": {
      if (_prefs) await _prefs.blockCampaign(msg.campaignId);
      const preferences = _prefs ? await _prefs.getPreferences() : defaultPreferences();
      return { preferences };
    }

    case "UNBLOCK_CAMPAIGN": {
      if (_prefs) await _prefs.unblockCampaign(msg.campaignId);
      const preferences = _prefs ? await _prefs.getPreferences() : defaultPreferences();
      return { preferences };
    }

    case "BLOCK_TAG": {
      if (_prefs) await _prefs.blockTag(msg.tag);
      return { ok: true };
    }

    case "UNBLOCK_TAG": {
      if (_prefs) await _prefs.unblockTag(msg.tag);
      return { ok: true };
    }

    // ── Interest profile ───────────────────────────────────────────────────
    case "GET_INTEREST_PROFILE": {
      const profile = _interest ? await _interest.getProfile() : {};
      return { profile };
    }

    case "RESET_INTEREST_PROFILE": {
      if (_interest) await _interest.resetProfile();
      return { ok: true };
    }

    // ── Publisher attestation ──────────────────────────────────────────────
    case "REQUEST_PUBLISHER_ATTESTATION": {
      if (!_attest) return { signature: undefined, error: "attestation unavailable" };
      const result = await _attest.requestPublisherAttestation(
        msg.publisherAddress, msg.campaignId, msg.userAddress,
        msg.firstNonce, msg.lastNonce, msg.claimCount,
      );
      return { signature: result.signature || undefined, error: result.error };
    }

    // ── Wallet events ──────────────────────────────────────────────────────
    case "WALLET_CONNECTED": {
      await chrome.storage.local.set({ connectedAddress: msg.address });
      return { ok: true };
    }

    case "WALLET_DISCONNECTED": {
      await chrome.storage.local.remove("connectedAddress");
      return { ok: true };
    }

    // ── Settings ───────────────────────────────────────────────────────────
    case "SETTINGS_UPDATED": {
      if (msg.settings) await chrome.storage.local.set({ settings: msg.settings });
      return { ok: true };
    }

    // ── Misc ───────────────────────────────────────────────────────────────
    case "GET_TIMELOCK_PENDING":
      return { pending: [] };

    case "CHECK_AUTO_SUBMIT":
      return { authorized: false };

    case "GET_AD_RATE": {
      const stored = await chrome.storage.local.get("impressionTimestamps");
      const ts: number[] = stored.impressionTimestamps ?? [];
      const count = ts.filter((t) => t >= Date.now() - 3_600_000).length;
      return { count };
    }

    case "REPORT_PAGE":
    case "REPORT_AD":
      return { ok: true };

    case "SYNC_CHAIN_STATE":
    case "RESET_CHAIN_STATE":
      return { ok: true };

    case "SIGN_FOR_RELAY":
      return { ok: false, reason: "auto-submit not available in demo" };

    case "AUTHORIZE_AUTO_SUBMIT":
    case "REVOKE_AUTO_SUBMIT":
      return { ok: true };

    default:
      return undefined;
  }
}

// ── Default preferences ────────────────────────────────────────────────────

function defaultPreferences() {
  return {
    blockedCampaigns: [],
    silencedCategories: [],
    blockedTags: [],
    maxAdsPerHour: 12,
    minBidCpm: "0",
    filterMode: "all",
    allowedTopics: [],
    sweepAddress: "",
    sweepThresholdPlanck: "0",
  };
}

// ── Register the message listener ──────────────────────────────────────────
// This runs at module evaluation time — the shim is already installed above.

chrome.runtime.onMessage.addListener(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (msg: any, _sender: any, sendResponse: any) => {
    handleMessage(msg)
      .then(sendResponse)
      .catch((err) => { console.warn("[daemon]", err); sendResponse({ error: String(err) }); });
    return true; // async response
  },
);

// ── Public init ────────────────────────────────────────────────────────────

let _started = false;

export async function startDaemon(): Promise<void> {
  if (_started) return;
  _started = true;

  // Dynamically import background submodules — shim is already installed.
  // Skipping claimBuilder intentionally (needs snarkjs / circuit files).
  const [
    { campaignPoller },
    { claimQueue },
    { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag },
    { interestProfile },
    { requestPublisherAttestation },
  ] = await Promise.all([
    import("@ext/background/campaignPoller"),
    import("@ext/background/claimQueue"),
    import("@ext/background/userPreferences"),
    import("@ext/background/interestProfile"),
    import("@ext/background/publisherAttestation"),
  ]);

  _poller    = campaignPoller;
  _queue     = claimQueue;
  _prefs     = { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag };
  _interest  = interestProfile;
  _attest    = { requestPublisherAttestation };

  // Seed settings (network + contract addresses) on first run.
  const stored = await chrome.storage.local.get("settings");
  const existing = stored.settings ?? {
    network: "polkadotTestnet",
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    contractAddresses: {},
    ipfsGateway: "https://ipfs.io/ipfs/",
    autoSubmit: false,
    autoSubmitIntervalMinutes: 60,
  };

  if (!existing.contractAddresses?.campaigns) {
    try {
      const resp = await fetch("/deployed-addresses.json");
      if (resp.ok) {
        const addrs = await resp.json();
        await chrome.storage.local.set({
          settings: { ...existing, contractAddresses: { ...existing.contractAddresses, ...addrs } },
        });
        console.log("[datum-daemon] seeded contract addresses");
      }
    } catch (e) {
      console.warn("[datum-daemon] could not load deployed-addresses.json", e);
    }
  } else {
    // Ensure settings exist even if addresses already loaded
    await chrome.storage.local.set({ settings: existing });
  }

  // Kick off first campaign poll.
  try {
    const s = (await chrome.storage.local.get("settings")).settings;
    if (s?.rpcUrl && s?.contractAddresses?.campaigns) {
      console.log("[datum-daemon] starting campaign poll");
      campaignPoller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway).catch(console.warn);
    }
  } catch (e) {
    console.warn("[datum-daemon] initial poll failed:", e);
  }
}
