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
import DatumAttestationVerifierAbi from "@shared/abis/DatumAttestationVerifier.json";
import { encryptPrivateKey, decryptPrivateKey, EncryptedWalletData } from "@shared/walletManager";
import { refreshPhishingList, isAddressBlocked, isUrlPhishing } from "@shared/phishingList";
import { validateAndSanitize, passesContentBlocklist, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { metadataUrl } from "@shared/ipfs";

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

    // Sync deployed addresses from bundled file — catches fresh installs AND
    // upgrades where the bundled addresses changed (e.g. alpha-1 → alpha-2).
    const loaded = await tryLoadDeployedAddresses();
    if (loaded && loaded.campaigns) {
      const stale = settings.contractAddresses.campaigns !== loaded.campaigns;
      const empty = !settings.contractAddresses.campaigns;
      if (empty || stale) {
        settings = { ...settings, contractAddresses: { ...settings.contractAddresses, ...loaded } };
        await chrome.storage.local.set({ settings });
        console.log(`[DATUM] ${empty ? "Auto-loaded" : "Updated stale"} contract addresses from deployed-addresses.json`);
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
      paymentVault: addrs.paymentVault ?? "",
      budgetLedger: addrs.budgetLedger ?? "",
      lifecycle: addrs.lifecycle ?? "",
      attestationVerifier: addrs.attestationVerifier ?? "",
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
    await refreshPhishingList();
    const settings = await getSettings();
    if (settings.contractAddresses.campaigns) {
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway);
      // Prune claims for campaigns that are no longer active (withdrawn, terminated, etc.)
      const active = await campaignPoller.getCachedSerialized();
      const activeIds = new Set(active.map((c) => c.id));
      const pruned = await claimQueue.pruneInactiveCampaigns(activeIds);
      if (pruned > 0) console.log(`[DATUM] Pruned ${pruned} stale claims for inactive campaigns`);

      // UP-3: Auto-cleanup blocked campaign IDs for terminal campaigns
      const prefs = await getPreferences();
      if (prefs.blockedCampaigns.length > 0) {
        const stillRelevant = prefs.blockedCampaigns.filter((id) => activeIds.has(id));
        if (stillRelevant.length < prefs.blockedCampaigns.length) {
          await updatePreferences({ blockedCampaigns: stillRelevant });
          console.log(`[DATUM] Cleaned ${prefs.blockedCampaigns.length - stillRelevant.length} stale blocked campaign IDs`);
        }
      }
    }

    // E-M4: Remove expired signed relay batches from storage
    try {
      const stored = await chrome.storage.local.get("signedBatches");
      if (stored.signedBatches?.deadline) {
        const provider = new JsonRpcProvider(settings.rpcUrl);
        const currentBlock = await provider.getBlockNumber();
        if (stored.signedBatches.deadline <= currentBlock) {
          await chrome.storage.local.remove("signedBatches");
          console.log("[DATUM] Removed expired signed relay batches");
        }
      }
    } catch { /* non-critical */ }

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

/** Check if a message sender is the extension itself (popup or background). */
function isExtensionOrigin(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab;
}

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground | PopupToBackground, sender, sendResponse) => {
    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((err) => {
        console.error("[DATUM background] message error:", err);
        sendResponse({ error: String(err) });
      });
    return true; // async response
  }
);

// Safe RPC methods that content scripts can proxy without approval
const SAFE_RPC_METHODS = new Set([
  "eth_accounts", "eth_requestAccounts", "eth_chainId", "eth_blockNumber",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance",
  "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas",
  "eth_gasPrice", "eth_getTransactionCount", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "net_version", "web3_clientVersion",
]);

async function handleMessage(
  msg: ContentToBackground | PopupToBackground,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case "IMPRESSION_RECORDED": {
      // Check rate limit before recording
      const prefs = await getPreferences();
      const withinLimit = await checkRateLimit(prefs.maxAdsPerHour);
      if (!withinLimit) {
        console.warn(`[DATUM] Impression rate-limited (max ${prefs.maxAdsPerHour}/hr)`);
        return { ok: false, reason: "rate_limited" };
      }

      await recordImpressionTime();
      try {
        await claimBuilder.onImpression(msg);
        console.log(`[DATUM] Claim built for campaign ${msg.campaignId}`);
      } catch (err) {
        console.error("[DATUM] claimBuilder.onImpression failed:", err);
        return { ok: false, reason: "claim_build_error" };
      }
      return { ok: true };
    }

    case "SET_PUBLISHER_RELAY": {
      // Content script detected a publisher relay URL from the SDK data-relay attribute
      const { publisher: pub, relay: relayUrl } = msg as any;
      if (pub && relayUrl && /^0x[0-9a-fA-F]{40}$/.test(pub)) {
        // Strip protocol — publisherAttestation.ts builds https:// URL from bare domain
        const domain = relayUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const key = `publisherDomain:${pub.toLowerCase()}`;
        await chrome.storage.local.set({ [key]: domain });
        console.log(`[DATUM] Publisher relay set: ${pub.slice(0, 10)}... → ${domain}`);
      }
      return { ok: true };
    }

    case "GET_ACTIVE_CAMPAIGNS": {
      const cached = await campaignPoller.getCachedSerialized();
      return { campaigns: cached };
    }

    case "FETCH_IPFS_METADATA": {
      // Content script requests metadata fetch (background has no CSP restrictions)
      const { campaignId: cid, metadataHash: mHash } = msg as any;
      console.log(`[DATUM] FETCH_IPFS_METADATA: campaignId=${cid}, hash=${mHash}`);
      if (!cid || !mHash) return { metadata: null };
      const s = await getSettings();
      const primaryGateway = s.ipfsGateway || "https://dweb.link/ipfs/";
      // Try multiple gateways for reliability
      const gateways = [
        primaryGateway,
        "https://ipfs.io/ipfs/",
        "https://cloudflare-ipfs.com/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
      ];
      // Deduplicate (in case primaryGateway is already in the list)
      const uniqueGateways = [...new Set(gateways.map(g => g.endsWith("/") ? g : g + "/"))];

      for (const gw of uniqueGateways) {
        const url = metadataUrl(mHash, gw);
        if (!url) continue;
        try {
          console.log(`[DATUM] FETCH_IPFS_METADATA: trying ${url}`);
          const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!resp.ok) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: ${gw} returned ${resp.status}`);
            continue;
          }
          const bodyText = await resp.text();
          if (bodyText.length > MAX_METADATA_BYTES) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: body too large (${bodyText.length})`);
            return { metadata: null };
          }
          const meta = validateAndSanitize(JSON.parse(bodyText));
          if (!meta) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: validation failed`);
            return { metadata: null };
          }
          if (!passesContentBlocklist(meta)) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: blocklist failed`);
            return { metadata: null };
          }
          if (meta.creative.ctaUrl && await isUrlPhishing(meta.creative.ctaUrl)) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: phishing check failed`);
            return { metadata: null };
          }
          // Cache for future use
          const metaKey = `metadata:${cid}`;
          await chrome.storage.local.set({ [metaKey]: meta, [`metadata_ts:${cid}`]: Date.now() });
          console.log(`[DATUM] FETCH_IPFS_METADATA: success from ${gw}`);
          return { metadata: meta };
        } catch (err) {
          console.warn(`[DATUM] FETCH_IPFS_METADATA: ${gw} error:`, err);
          continue;
        }
      }
      console.warn(`[DATUM] FETCH_IPFS_METADATA: all gateways failed for campaign ${cid}`);
      return { metadata: null };
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

    case "SUBMIT_CAMPAIGN_CLAIMS": {
      const batch = await claimQueue.buildBatchForCampaign(msg.userAddress, msg.campaignId);
      if (!batch) return { batch: null };
      return { batch: serializeBatches([batch])[0] };
    }

    case "DISCARD_CAMPAIGN_CLAIMS": {
      const removed = await claimQueue.discardCampaignClaims(msg.userAddress, msg.campaignId);
      return { removed };
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

      // Filter out campaigns with blocked advertiser/publisher addresses
      const safeAllowed: typeof allowed = [];
      for (const c of allowed) {
        const advBlocked = await isAddressBlocked(c.advertiser ?? "");
        const pubBlocked = await isAddressBlocked(c.publisher ?? "");
        if (advBlocked || pubBlocked) {
          console.warn(`[DATUM] Campaign ${c.id} filtered — blocked address`);
          continue;
        }
        safeAllowed.push(c);
      }

      if (safeAllowed.length === 0) return { selected: null };

      // Run auction
      const profile = await interestProfile.getProfile();
      const auctionResult = auctionForPage(
        safeAllowed as CampaignCandidate[],
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
      const selected = selectCampaign(safeAllowed, profile, msg.pageCategory);
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
      const attestResult = await requestPublisherAttestation(
        msg.publisherAddress,
        msg.campaignId,
        msg.userAddress,
        msg.firstNonce,
        msg.lastNonce,
        msg.claimCount
      );
      return { signature: attestResult.signature || undefined, error: attestResult.error };
    }

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
      await authorizeAutoSubmit(msg.password);
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

    // -----------------------------------------------------------------------
    // window.datum provider bridge (content/provider.ts → EIP-1193 proxy)
    // -----------------------------------------------------------------------

    case "PROVIDER_GET_ADDRESS": {
      const stored = await chrome.storage.local.get("connectedAddress");
      return { address: stored.connectedAddress ?? null };
    }

    case "PROVIDER_GET_CHAIN_ID": {
      const s = await getSettings();
      try {
        const provider = new JsonRpcProvider(s.rpcUrl);
        const network = await provider.getNetwork();
        return { chainId: "0x" + network.chainId.toString(16) };
      } catch {
        return { chainId: "0x1" };
      }
    }

    case "PROVIDER_SIGN_TYPED_DATA": {
      // Only allow signing from the extension's own web app pages, not arbitrary content scripts
      if (!isExtensionOrigin(sender)) {
        return { error: "Signing requests must originate from the DATUM extension." };
      }
      const { getUnlockedWallet } = await import("@shared/walletManager");
      const wallet = getUnlockedWallet();
      if (!wallet) return { error: "Wallet is locked. Unlock it in the extension popup first." };
      try {
        const signature = await wallet.signTypedData(msg.domain, msg.types, msg.value);
        return { signature };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    }

    case "PROVIDER_PERSONAL_SIGN": {
      if (!isExtensionOrigin(sender)) {
        return { error: "Signing requests must originate from the DATUM extension." };
      }
      const { getUnlockedWallet: getWallet } = await import("@shared/walletManager");
      const w = getWallet();
      if (!w) return { error: "Wallet is locked. Unlock it in the extension popup first." };
      try {
        const signature = await w.signMessage(msg.message);
        return { signature };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    }

    case "PROVIDER_RPC_PROXY": {
      // Only allow safe read-only RPC methods — reject state-changing or admin calls
      if (!SAFE_RPC_METHODS.has(msg.method)) {
        return { error: `RPC method '${msg.method}' is not allowed through the provider bridge.` };
      }
      const s2 = await getSettings();
      try {
        const provider = new JsonRpcProvider(s2.rpcUrl);
        const result = await provider.send(msg.method, msg.params ?? []);
        return { result };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    }

    case "PROVIDER_CONNECT":
    case "PROVIDER_DISCONNECT": {
      const stored2 = await chrome.storage.local.get("connectedAddress");
      return { address: stored2.connectedAddress ?? null };
    }

    case "PROVIDER_APPROVAL_RESPONSE": {
      // Future: popup approval flow — for now auto-approve (wallet must be unlocked)
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

/** Authorize auto-submit: decrypt wallet with user password, re-encrypt with random session password. */
async function authorizeAutoSubmit(walletPassword: string): Promise<void> {
  // Decrypt the wallet's private key using the user-supplied password
  const { getActiveWalletEncrypted } = await import("@shared/walletManager");
  const walletEncrypted = await getActiveWalletEncrypted();
  if (!walletEncrypted) throw new Error("No wallet found");
  const privateKey = await decryptPrivateKey(walletEncrypted, walletPassword);

  // Generate a random session password (32 bytes hex)
  const sessionBytes = crypto.getRandomValues(new Uint8Array(32));
  autoSubmitSessionPassword = hexlify(sessionBytes);

  // Re-encrypt with session password (session-scoped, lost on SW restart)
  const encrypted = await encryptPrivateKey(privateKey, autoSubmitSessionPassword);
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
    if (!settings.contractAddresses.attestationVerifier || !settings.autoSubmit) {
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

    if (!settings.contractAddresses.attestationVerifier) {
      console.log("[DATUM] Auto-flush skipped — attestationVerifier address not configured");
      await claimQueue.releaseMutex();
      return;
    }

    const provider = new JsonRpcProvider(settings.rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const attestationVerifier = new Contract(
      settings.contractAddresses.attestationVerifier,
      DatumAttestationVerifierAbi.abi,
      wallet
    );

    // Build AttestedBatch[] — request publisher co-signature for each batch
    const attestedBatches = await Promise.all(batches.map(async (b) => {
      const publisher = b.claims[0]?.publisher ?? "";
      let publisherSig = "0x";
      try {
        const attestResult = await requestPublisherAttestation(
          publisher,
          b.campaignId.toString(),
          b.user,
          b.claims[0].nonce.toString(),
          b.claims[b.claims.length - 1].nonce.toString(),
          b.claims.length,
        );
        if (attestResult.signature) publisherSig = attestResult.signature;
        if (attestResult.error) console.warn(`[DATUM] Auto-flush attestation warning for campaign ${b.campaignId}: ${attestResult.error}`);
      } catch {
        // Attestation unavailable — degraded trust mode
      }
      return {
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
        publisherSig,
      };
    }));

    let settledCount = 0;
    let rejectedCount = 0;

    const tx = await attestationVerifier.settleClaimsAttested(attestedBatches);
    const receipt = await tx.wait();

    if (receipt?.logs) {
      const iface = attestationVerifier.interface;
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
