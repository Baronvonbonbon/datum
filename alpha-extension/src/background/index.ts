// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { Wallet, JsonRpcProvider, Contract, hexlify, getBytes } from "ethers";
import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { interestProfile } from "./interestProfile";
import { selectCampaign } from "./campaignMatcher";
import { auctionForPage, CampaignCandidate } from "./auction";
import { requestPublisherAttestation } from "./publisherAttestation";
import { getPreferences, updatePreferences, blockCampaign, unblockCampaign, isCampaignAllowed, checkRateLimit, recordImpressionTime } from "./userPreferences";
import { appendEvent } from "./behaviorChain";
import { computeQualityScore, meetsQualityThreshold } from "@shared/qualityScore";
import { timelockMonitor } from "./timelockMonitor";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { ClaimBatch, SerializedClaimBatch, CATEGORY_NAMES } from "@shared/types";
import DatumSettlementAbi from "@shared/abis/DatumSettlement.json";
import { encryptPrivateKey, decryptPrivateKey, EncryptedWalletData } from "@shared/walletManager";

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
    return {
      campaigns: addrs.campaigns ?? "",
      publishers: addrs.publishers ?? "",
      governanceV2: addrs.governanceV2 ?? "",
      governanceSlash: addrs.governanceSlash ?? "",
      settlement: addrs.settlement ?? "",
      relay: addrs.relay ?? "",
      pauseRegistry: addrs.pauseRegistry ?? "",
      timelock: addrs.timelock ?? "",
      zkVerifier: addrs.zkVerifier ?? "",
    };
  } catch {
    return null;
  }
}

async function initAlarms() {
  const settings = await getSettings();

  // Clear before recreating — chrome alarms have a minimum 1-min delay
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
    // H2: Poll timelock for pending admin changes
    if (settings.contractAddresses.timelock) {
      await timelockMonitor.poll(settings.rpcUrl, settings.contractAddresses);
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
    case "IMPRESSION_RECORDED": {
      // Check rate limit before recording
      const prefs = await getPreferences();
      const withinLimit = await checkRateLimit(prefs.maxAdsPerHour);
      if (!withinLimit) return { ok: false, reason: "rate_limited" };

      await recordImpressionTime();
      await claimBuilder.onImpression(msg);
      return { ok: true };
    }

    case "GET_ACTIVE_CAMPAIGNS": {
      const cached = await campaignPoller.getCachedSerialized();
      return { campaigns: cached };
    }

    case "POLL_CAMPAIGNS": {
      const s = await getSettings();
      if (s.contractAddresses.campaigns) {
        await campaignPoller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway);
        const refreshed = await campaignPoller.getCachedSerialized();
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
      const batches = await claimQueue.buildBatches(msg.userAddress);
      return { batches: serializeBatches(batches) };
    }

    case "SIGN_FOR_RELAY": {
      const allBatches = await claimQueue.buildBatches(msg.userAddress);
      const filtered = allBatches.filter(
        (b) => b.campaignId.toString() === msg.campaignId
      );
      return { batches: serializeBatches(filtered) };
    }

    case "SETTINGS_UPDATED": {
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
      const allKeys = await chrome.storage.local.get(null);
      const chainStateKeys = Object.keys(allKeys).filter((k) =>
        k.startsWith("chainState:")
      );
      if (chainStateKeys.length > 0) {
        await chrome.storage.local.remove(chainStateKeys);
      }
      await claimQueue.clear();
      return { ok: true, cleared: chainStateKeys.length };
    }

    case "UPDATE_INTEREST": {
      await interestProfile.updateProfile(msg.category);
      return { ok: true };
    }

    case "SELECT_CAMPAIGN": {
      // Filter through user preferences first
      const prefs = await getPreferences();
      const allowed = msg.campaigns.filter((c: any) =>
        isCampaignAllowed(
          { id: c.id, categoryId: Number(c.categoryId ?? 0), bidCpmPlanck: c.bidCpmPlanck },
          prefs,
          CATEGORY_NAMES,
        )
      );

      if (allowed.length === 0) return { selected: null };

      // Run auction
      const profile = await interestProfile.getProfile();
      const auctionResult = auctionForPage(
        allowed as CampaignCandidate[],
        {}, // pageCategories not used in auction directly
        profile,
      );

      if (auctionResult) {
        return {
          selected: auctionResult.winner,
          clearingCpmPlanck: auctionResult.clearingCpmPlanck.toString(),
          mechanism: auctionResult.mechanism,
          participants: auctionResult.participants,
        };
      }

      // Fallback to legacy matcher
      const selected = selectCampaign(allowed, profile, msg.pageCategory);
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

    // Governance V2 actions (handled directly in popup via contract calls)
    case "EVALUATE_CAMPAIGN":
    case "FINALIZE_SLASH":
    case "CLAIM_SLASH_REWARD":
      // These are handled directly by the popup panels via ethers contract calls,
      // not routed through background. Return ok for compatibility.
      return { ok: true, note: "Handled in popup" };

    // User preferences
    case "GET_USER_PREFERENCES": {
      const preferences = await getPreferences();
      return { preferences };
    }

    case "UPDATE_USER_PREFERENCES": {
      const updated = await updatePreferences(msg.preferences);
      return { preferences: updated };
    }

    case "BLOCK_CAMPAIGN": {
      await blockCampaign(msg.campaignId);
      const preferences = await getPreferences();
      return { preferences };
    }

    case "UNBLOCK_CAMPAIGN": {
      await unblockCampaign(msg.campaignId);
      const preferences = await getPreferences();
      return { preferences };
    }

    // Engagement tracking — quality score computed here (trusted background),
    // not in content script (untrusted). Low-quality impressions are rejected.
    case "ENGAGEMENT_RECORDED": {
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress = stored.connectedAddress;
      if (userAddress && msg.event) {
        await appendEvent(userAddress, msg.event);

        // Compute quality score in trusted background context
        const qualityScore = computeQualityScore(msg.event);
        if (!meetsQualityThreshold(msg.event)) {
          // Remove the queued claim for this campaign (below quality threshold)
          const qStored = await chrome.storage.local.get("claimQueue");
          const queue: any[] = qStored.claimQueue ?? [];
          // Find and remove the most recent claim for this user+campaign
          const idx = queue.findLastIndex(
            (c: any) => c.userAddress === userAddress && c.campaignId === msg.event.campaignId
          );
          if (idx !== -1) {
            queue.splice(idx, 1);
            await chrome.storage.local.set({ claimQueue: queue });
            console.log(`[DATUM] Rejected low-quality impression for campaign ${msg.event.campaignId} (score: ${qualityScore.toFixed(2)})`);
          }
        }
      }
      return { ok: true };
    }

    // B1: Auto-submit key management (encrypted)
    case "AUTHORIZE_AUTO_SUBMIT": {
      await authorizeAutoSubmit(msg.privateKey);
      return { ok: true };
    }

    case "REVOKE_AUTO_SUBMIT": {
      await revokeAutoSubmit();
      return { ok: true };
    }

    case "CHECK_AUTO_SUBMIT": {
      const authorized = await isAutoSubmitAuthorized();
      return { authorized };
    }

    // H2: Timelock pending changes
    case "GET_TIMELOCK_PENDING": {
      const pending = await timelockMonitor.getPending();
      return { pending };
    }

    // Legacy: ENGAGEMENT_QUALITY_RESULT no longer sent by content script.
    // Quality scoring moved to ENGAGEMENT_RECORDED handler above.
    case "ENGAGEMENT_QUALITY_RESULT": {
      return { ok: true };
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
// B1: Private key encrypted at rest with session-scoped password.
// Session password is held in memory only — lost on service worker restart.
// -------------------------------------------------------------------------

const AUTO_FLUSH_RESULT_KEY = "lastAutoFlushResult";
const AUTO_SUBMIT_ENCRYPTED_KEY = "autoSubmitKeyEncrypted";

// Session-scoped password: random, held in memory, lost on SW restart
let autoSubmitSessionPassword: string | null = null;

/** Authorize auto-submit: encrypt the private key with a random session password. */
async function authorizeAutoSubmit(walletPrivateKey: string): Promise<void> {
  // Generate a random session password (32 bytes hex)
  const sessionBytes = crypto.getRandomValues(new Uint8Array(32));
  autoSubmitSessionPassword = hexlify(sessionBytes);

  // Encrypt the private key using PBKDF2+AES-256-GCM (same as walletManager)
  const encrypted = await encryptPrivateKey(walletPrivateKey, autoSubmitSessionPassword);
  await chrome.storage.local.set({ [AUTO_SUBMIT_ENCRYPTED_KEY]: encrypted });
}

/** Revoke auto-submit: clear encrypted key and session password. */
async function revokeAutoSubmit(): Promise<void> {
  autoSubmitSessionPassword = null;
  await chrome.storage.local.remove(AUTO_SUBMIT_ENCRYPTED_KEY);
}

/** Check if auto-submit is currently authorized (session password in memory + encrypted key in storage). */
async function isAutoSubmitAuthorized(): Promise<boolean> {
  if (!autoSubmitSessionPassword) return false;
  const stored = await chrome.storage.local.get(AUTO_SUBMIT_ENCRYPTED_KEY);
  return !!stored[AUTO_SUBMIT_ENCRYPTED_KEY];
}

/** Decrypt auto-submit key using in-memory session password. Returns null if unavailable. */
async function getAutoSubmitKey(): Promise<string | null> {
  if (!autoSubmitSessionPassword) return null;
  const stored = await chrome.storage.local.get(AUTO_SUBMIT_ENCRYPTED_KEY);
  const encrypted: EncryptedWalletData | undefined = stored[AUTO_SUBMIT_ENCRYPTED_KEY];
  if (!encrypted) return null;
  try {
    return await decryptPrivateKey(encrypted, autoSubmitSessionPassword);
  } catch {
    // Session password mismatch (shouldn't happen unless storage was tampered)
    autoSubmitSessionPassword = null;
    return null;
  }
}

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

    // Check global pause before submission
    if (settings.contractAddresses.pauseRegistry) {
      try {
        const provider = new JsonRpcProvider(settings.rpcUrl);
        const { getPauseRegistryContract } = await import("@shared/contracts");
        const pauseRegistry = getPauseRegistryContract(settings.contractAddresses, provider);
        const paused = await pauseRegistry.paused();
        if (paused) {
          console.log("[DATUM] Auto-flush skipped — system paused");
          await claimQueue.releaseMutex();
          return;
        }
      } catch (err) {
        console.warn("[DATUM] Could not check pause status:", err);
      }
    }

    const stored = await chrome.storage.local.get("connectedAddress");
    const userAddress: string | undefined = stored.connectedAddress;
    const privateKey = await getAutoSubmitKey();

    if (!userAddress || !privateKey) {
      console.log("[DATUM] Auto-flush skipped — no connected wallet or auto-submit not authorized (re-authorize after browser restart)");
      await claimQueue.releaseMutex();
      return;
    }

    const batches = await claimQueue.buildBatches(userAddress);
    if (batches.length === 0) {
      await claimQueue.releaseMutex();
      return;
    }

    await chrome.storage.local.set({ lastAutoFlush: Date.now() });

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
