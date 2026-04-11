// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { Wallet, JsonRpcProvider, Contract, hexlify, getBytes, ZeroHash } from "ethers";
import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { interestProfile } from "./interestProfile";
import { selectCampaign } from "./campaignMatcher";
import { auctionForPage, CampaignCandidate } from "./auction";
import { requestPublisherAttestation } from "./publisherAttestation";
import { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag, isCampaignAllowed, checkRateLimit, recordImpressionTime } from "./userPreferences";
import { appendEvent, cleanupTerminalChains } from "./behaviorChain";
import { computeQualityScore, meetsQualityThreshold } from "@shared/qualityScore";
import { timelockMonitor } from "./timelockMonitor";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { ClaimBatch, SerializedClaimBatch } from "@shared/types";
import DatumAttestationVerifierAbi from "@shared/abis/DatumAttestationVerifier.json";
import { encryptPrivateKey, decryptPrivateKey, EncryptedWalletData } from "@shared/walletManager";
import { getPaymentVaultContract, getSettlementContract } from "@shared/contracts";
import { refreshPhishingList, isAddressBlocked, isUrlPhishing } from "@shared/phishingList";
import { validateAndSanitize, passesContentBlocklist, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { metadataUrl } from "@shared/ipfs";
import { tagStringFromHash } from "@shared/tagDictionary";

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
  // XM-14: Flag that auto-submit was deauthorized (session password lost on SW restart)
  await chrome.storage.local.set({ autoSubmitDeauthNotice: true });
  // XL-5: Clean up orphaned encrypted auto-submit key (session password is gone)
  await chrome.storage.local.remove("autoSubmitKeyEncrypted");
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

      // UB-2: Clean up behavior chain storage for terminal campaigns
      const chainsCleaned = await cleanupTerminalChains(activeIds);
      if (chainsCleaned > 0) console.log(`[DATUM] Cleaned ${chainsCleaned} behavior chain entries for terminal campaigns`);

      // CL-4: Clean up metadata + impression dedup storage for terminal campaigns
      try {
        const allKeys = await chrome.storage.local.get(null);
        const staleKeys: string[] = [];
        for (const key of Object.keys(allKeys)) {
          const metaMatch = key.match(/^metadata:(\d+)$/) || key.match(/^metadata_ts:(\d+)$/);
          const impMatch = key.match(/^impression:(\d+):/);
          const id = metaMatch?.[1] ?? impMatch?.[1];
          if (id && !activeIds.has(id)) staleKeys.push(key);
        }
        if (staleKeys.length > 0) {
          await chrome.storage.local.remove(staleKeys);
          console.log(`[DATUM] Cleaned ${staleKeys.length} stale metadata/impression keys`);
        }
      } catch { /* non-critical */ }
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

/** Approved domains for provider signing (alpha — relaxed for testing).
 *  These match shouldInjectProvider() in content/provider.ts.
 *  TODO(mainnet): tighten to dynamic allowlist or popup approval flow. */
const APPROVED_SIGNING_DOMAINS = new Set([
  "datum.javcon.io",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

// XH-1: Pending signing approval requests — resolved when popup responds
interface ApprovalRequest {
  requestId: string;
  type: "personal_sign" | "sign_typed_data" | "send_transaction";
  domain: string;
  preview: string;
}
const pendingApprovals = new Map<string, {
  resolve: () => void;
  reject: (e: Error) => void;
  details: ApprovalRequest;
}>();

/** Extract hostname from a sender tab URL (or "unknown"). */
function senderHostname(sender: chrome.runtime.MessageSender): string {
  if (sender.tab?.url) { try { return new URL(sender.tab.url).hostname; } catch {} }
  return "unknown";
}

/** Store the pending approval in local storage and open a popup window.
 *  Returns a Promise that resolves when the user approves or rejects. */
async function requireApproval(details: ApprovalRequest): Promise<void> {
  await chrome.storage.local.set({ signingApprovalPending: details });
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html") + "?mode=approval",
    type: "popup",
    width: 380,
    height: 560,
    focused: true,
  });
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(details.requestId);
      chrome.storage.local.remove("signingApprovalPending");
      reject(new Error("Signing request timed out (60s)."));
    }, 60_000);
    pendingApprovals.set(details.requestId, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      details,
    });
  });
}

/** Check if a content-script sender is from an approved domain. */
function isApprovedSigningOrigin(sender: chrome.runtime.MessageSender): boolean {
  // Extension popup/background — always approved
  if (isExtensionOrigin(sender)) return true;
  // Content script — check the tab URL against approved domains
  if (sender.tab?.url) {
    try {
      const url = new URL(sender.tab.url);
      if (APPROVED_SIGNING_DOMAINS.has(url.hostname)) return true;
      if (url.hostname.endsWith(".datum.javcon.io")) return true;
      if (url.protocol === "chrome-extension:") return true;
    } catch { /* malformed URL — reject */ }
  }
  return false;
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

      // Record ad-exposure tags into interest profile (weighted by viewing)
      const campaignTags: string[] = (msg as any).campaignTags ?? [];
      if (campaignTags.length > 0) {
        const adTagStrings: string[] = [];
        for (const hash of campaignTags) {
          const tagStr = tagStringFromHash(hash);
          if (tagStr) adTagStrings.push(tagStr);
        }
        if (adTagStrings.length > 0) {
          await interestProfile.updateProfile(adTagStrings);
        }
      }

      return { ok: true };
    }

    case "SET_PUBLISHER_RELAY": {
      // XM-3: Validate relay URL — only accept HTTPS and verify sender tab domain matches relay domain
      const { publisher: pub, relay: relayUrl } = msg as any;
      if (pub && relayUrl && /^0x[0-9a-fA-F]{40}$/.test(pub)) {
        // Strip protocol — publisherAttestation.ts builds https:// URL from bare domain
        const domain = relayUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        // Reject non-HTTPS relay URLs (except localhost for development)
        const isLocal = domain === "localhost" || domain.startsWith("localhost:") || domain.startsWith("127.0.0.1");
        if (!isLocal && !relayUrl.startsWith("https://")) {
          console.warn(`[DATUM] Rejected non-HTTPS relay URL from content script: ${domain}`);
          return { ok: false, reason: "relay_must_be_https" };
        }
        // Verify sender tab's domain matches the relay domain (prevents cross-origin relay hijacking)
        if (sender.tab?.url) {
          try {
            const tabHost = new URL(sender.tab.url).hostname;
            const relayHost = domain.split(":")[0]; // strip port
            const tabMatches = tabHost === relayHost || tabHost.endsWith("." + relayHost);
            if (!tabMatches && !isLocal) {
              console.warn(`[DATUM] Rejected relay URL: tab domain ${tabHost} != relay domain ${relayHost}`);
              return { ok: false, reason: "relay_domain_mismatch" };
            }
          } catch { /* malformed URL — reject */
            return { ok: false, reason: "invalid_sender_url" };
          }
        }
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

    case "CHECK_PUBLISHER_ALLOWLIST": {
      const { publisher: pubAddr } = msg as any;
      if (!pubAddr || !/^0x[0-9a-fA-F]{40}$/.test(pubAddr)) return { allowlistEnabled: false };
      const s = await getSettings();
      if (!s.contractAddresses?.publishers) return { allowlistEnabled: false };
      try {
        const { getPublishersContract } = await import("@shared/contracts");
        const provider = new JsonRpcProvider(s.rpcUrl);
        const contract = getPublishersContract(s.contractAddresses, provider);
        const result = await contract.allowlistEnabled(pubAddr);
        return { allowlistEnabled: !!result };
      } catch {
        return { allowlistEnabled: false };
      }
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

      // XM-7: Extract expected SHA-256 digest from CIDv0 bytes32 hash for verification
      let expectedDigest: string | null = null;
      try {
        // mHash is bytes32 = raw SHA-256 digest (CIDv0 stripped of 0x1220 prefix)
        expectedDigest = mHash.toLowerCase();
      } catch { /* if hash format is unexpected, skip verification */ }

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
          const bodyBytes = new Uint8Array(await resp.arrayBuffer());
          if (bodyBytes.length > MAX_METADATA_BYTES) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: body too large (${bodyBytes.length})`);
            return { metadata: null };
          }

          // XM-7: Verify SHA-256 hash of content matches on-chain CIDv0 digest
          if (expectedDigest) {
            const hashBuffer = await crypto.subtle.digest("SHA-256", bodyBytes);
            const actualDigest = "0x" + Array.from(new Uint8Array(hashBuffer))
              .map(b => b.toString(16).padStart(2, "0")).join("");
            if (actualDigest.toLowerCase() !== expectedDigest) {
              console.warn(`[DATUM] FETCH_IPFS_METADATA: hash mismatch from ${gw} (expected ${expectedDigest.slice(0,18)}..., got ${actualDigest.slice(0,18)}...)`);
              continue; // try next gateway — this one returned tampered content
            }
          }

          const bodyText = new TextDecoder().decode(bodyBytes);
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
          console.log(`[DATUM] FETCH_IPFS_METADATA: success from ${gw} (hash verified)`);
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
      // Seed chain state from on-chain so future impressions start at the right nonce.
      // Resetting to (0, ZeroHash) causes a mismatch if prior settlements exist on-chain.
      try {
        const s = await getSettings();
        const p = new JsonRpcProvider(s.rpcUrl);
        const stl = getSettlementContract(s.contractAddresses, p);
        const [onChainNonce, onChainHash] = await Promise.all([
          stl.lastNonce(msg.userAddress, msg.campaignId),
          stl.lastClaimHash(msg.userAddress, msg.campaignId),
        ]);
        await claimBuilder.syncFromChain(msg.userAddress, msg.campaignId, Number(onChainNonce), onChainHash);
      } catch {
        // RPC failure — leave chain state intact rather than resetting to (0, ZeroHash).
        // Resetting corrupts the hash chain if prior settlements exist on-chain.
        // pruneSettledClaims will resync when RPC recovers.
        console.warn("[DATUM] DISCARD_CAMPAIGN_CLAIMS: RPC failed, preserving existing chain state");
      }
      return { removed };
    }

    case "DISCARD_REJECTED_CLAIMS": {
      // Triggered by offscreen after on-chain verification of a settlement tx.
      // Seed chain state from on-chain so next impressions start at the correct nonce.
      const s = await getSettings();
      const p = new JsonRpcProvider(s.rpcUrl);
      const stl = getSettlementContract(s.contractAddresses, p);
      for (const campaignId of msg.campaignIds) {
        await claimQueue.discardCampaignClaims(msg.userAddress, campaignId);
        try {
          const [onChainNonce, onChainHash] = await Promise.all([
            stl.lastNonce(msg.userAddress, campaignId),
            stl.lastClaimHash(msg.userAddress, campaignId),
          ]);
          await claimBuilder.syncFromChain(msg.userAddress, campaignId, Number(onChainNonce), onChainHash);
        } catch {
          console.warn(`[DATUM] DISCARD_REJECTED_CLAIMS: RPC failed for campaign ${campaignId}, preserving existing chain state`);
        }
      }
      return { ok: true };
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
      await interestProfile.updateProfile(msg.tags ?? []);
      return { ok: true };
    }

    case "SELECT_CAMPAIGN": {
      // Filter through user preferences first
      const prefs = await getPreferences();
      const allowed = msg.campaigns.filter((c: any) =>
        isCampaignAllowed(
          { id: c.id, categoryId: Number(c.categoryId ?? 0), bidCpmPlanck: c.bidCpmPlanck, requiredTags: c.requiredTags },
          prefs,
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

    // UB-4: Return ads-shown-this-hour count
    case "GET_AD_RATE": {
      const stored = await chrome.storage.local.get("impressionTimestamps");
      const timestamps: number[] = stored.impressionTimestamps ?? [];
      const oneHourAgo = Date.now() - 3600_000;
      const count = timestamps.filter((t: number) => t >= oneHourAgo).length;
      return { count };
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

    case "BLOCK_TAG": {
      await blockTag(msg.tag);
      const preferences = await getPreferences();
      return { preferences };
    }

    case "UNBLOCK_TAG": {
      await unblockTag(msg.tag);
      const preferences = await getPreferences();
      return { preferences };
    }

    case "REPORT_PAGE":
    case "REPORT_AD": {
      const s = await getSettings();
      if (!s.contractAddresses.reports) return { ok: false, error: "Reports contract not configured" };
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress: string | undefined = stored.connectedAddress;
      if (!userAddress) return { ok: false, error: "Wallet not connected" };
      try {
        const { getReportsContract } = await import("@shared/contracts");
        const { getSigner: getWalletSigner } = await import("@shared/walletManager");
        const signer = getWalletSigner(s.rpcUrl);
        const reports = getReportsContract(s.contractAddresses, signer);
        const fn = msg.type === "REPORT_PAGE" ? reports.reportPage : reports.reportAd;
        const tx = await fn(BigInt(msg.campaignId), msg.reason);
        await tx.wait();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err).slice(0, 120) };
      }
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
      // Return the active wallet address — try connectedAddress first, then wallet entries
      const stored = await chrome.storage.local.get(["connectedAddress", "activeWalletName"]);
      if (stored.connectedAddress) return { address: stored.connectedAddress };
      // Fallback: look up address from wallet entries (wallet may not be unlocked yet)
      if (stored.activeWalletName) {
        const { listWallets } = await import("@shared/walletManager");
        const wallets = await listWallets();
        const active = wallets.find((w) => w.name === stored.activeWalletName);
        if (active) {
          // Sync connectedAddress for future calls
          await chrome.storage.local.set({ connectedAddress: active.address });
          return { address: active.address };
        }
      }
      return { address: null };
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
      if (!isApprovedSigningOrigin(sender)) {
        return { error: "Signing requests must originate from an approved DATUM domain." };
      }
      const { getUnlockedWallet } = await import("@shared/walletManager");
      const wallet = getUnlockedWallet();
      if (!wallet) return { error: "Wallet is locked. Unlock it in the extension popup first." };
      // XH-1: External origins require explicit user approval
      if (!isExtensionOrigin(sender)) {
        const domain = senderHostname(sender);
        const primaryType = Object.keys(msg.types ?? {}).find((k) => k !== "EIP712Domain") ?? "unknown";
        const preview = `${primaryType} on ${msg.domain?.name ?? domain}`;
        try {
          await requireApproval({ requestId: msg.requestId, type: "sign_typed_data", domain, preview });
        } catch (err) {
          return { error: String(err instanceof Error ? err.message : err) };
        }
      }
      try {
        const signature = await wallet.signTypedData(msg.domain, msg.types, msg.value);
        return { signature };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    }

    case "PROVIDER_PERSONAL_SIGN": {
      if (!isApprovedSigningOrigin(sender)) {
        return { error: "Signing requests must originate from an approved DATUM domain." };
      }
      const { getUnlockedWallet: getWallet } = await import("@shared/walletManager");
      const w = getWallet();
      if (!w) return { error: "Wallet is locked. Unlock it in the extension popup first." };
      // XH-1: External origins require explicit user approval
      if (!isExtensionOrigin(sender)) {
        const domain = senderHostname(sender);
        const rawMsg = typeof msg.message === "string" ? msg.message : JSON.stringify(msg.message);
        const preview = rawMsg.length > 80 ? rawMsg.slice(0, 77) + "…" : rawMsg;
        try {
          await requireApproval({ requestId: msg.requestId, type: "personal_sign", domain, preview });
        } catch (err) {
          return { error: String(err instanceof Error ? err.message : err) };
        }
      }
      try {
        const signature = await w.signMessage(msg.message);
        return { signature };
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    }

    case "PROVIDER_SEND_TRANSACTION": {
      if (!isApprovedSigningOrigin(sender)) {
        return { error: "Transaction requests must originate from an approved DATUM domain." };
      }
      const { getUnlockedWallet: getTxWallet } = await import("@shared/walletManager");
      const txWallet = getTxWallet();
      if (!txWallet) return { error: "Wallet is locked. Unlock it in the extension popup first." };
      // XH-1: External origins require explicit user approval
      if (!isExtensionOrigin(sender)) {
        const domain = senderHostname(sender);
        const txReqPrev = msg.tx ?? {};
        const toStr = txReqPrev.to ? String(txReqPrev.to).slice(0, 10) + "…" : "contract";
        const valStr = txReqPrev.value ? ` value=${txReqPrev.value}` : "";
        const preview = `Send tx to ${toStr}${valStr}`;
        try {
          await requireApproval({ requestId: msg.requestId, type: "send_transaction", domain, preview });
        } catch (err) {
          return { error: String(err instanceof Error ? err.message : err) };
        }
      }
      try {
        const s3 = await getSettings();
        const provider = new JsonRpcProvider(s3.rpcUrl);
        const signer = txWallet.connect(provider);
        const txReq = msg.tx ?? {};
        const txResp = await signer.sendTransaction({
          to: txReq.to,
          data: txReq.data,
          value: txReq.value,
          gasLimit: txReq.gas || txReq.gasLimit,
          ...(txReq.maxFeePerGas ? { maxFeePerGas: txReq.maxFeePerGas } : {}),
          ...(txReq.maxPriorityFeePerGas ? { maxPriorityFeePerGas: txReq.maxPriorityFeePerGas } : {}),
          ...(txReq.gasPrice ? { gasPrice: txReq.gasPrice } : {}),
          ...(txReq.nonce != null ? { nonce: txReq.nonce } : {}),
        });
        return { hash: txResp.hash };
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
      // XH-1: Resolve or reject the in-flight requireApproval() Promise
      const pending = pendingApprovals.get(msg.requestId);
      if (!pending) return { ok: false, error: "No pending approval found." };
      pendingApprovals.delete(msg.requestId);
      await chrome.storage.local.remove("signingApprovalPending");
      if (msg.approved) {
        pending.resolve();
      } else {
        pending.reject(new Error("User rejected the signing request."));
      }
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

/** Auto-sweep earnings to cold wallet if configured and threshold exceeded. Best-effort (errors logged, not thrown). */
async function tryAutoSweep(settings: Awaited<ReturnType<typeof getSettings>>, wallet: Wallet, userAddress: string): Promise<void> {
  try {
    const prefs = await getPreferences();
    const { sweepAddress, sweepThresholdPlanck } = prefs;
    if (!sweepAddress || !sweepThresholdPlanck || sweepThresholdPlanck === "0") return;

    // Basic address format check
    if (!/^0x[0-9a-fA-F]{40}$/.test(sweepAddress)) return;

    const threshold = BigInt(sweepThresholdPlanck);
    if (!settings.contractAddresses.paymentVault) return;

    const vault = getPaymentVaultContract(settings.contractAddresses, wallet);
    const balance: bigint = await vault.userBalance(userAddress);

    if (balance >= threshold && balance >= 1_000_000n) {
      console.log(`[DATUM] Auto-sweep: balance=${balance} >= threshold=${threshold}, sweeping to ${sweepAddress}`);
      const tx = await vault.withdrawUserTo(sweepAddress);
      await tx.wait();
      console.log(`[DATUM] Auto-sweep complete: swept ${balance} planck to ${sweepAddress}`);
    }
  } catch (err) {
    console.warn("[DATUM] Auto-sweep failed (non-fatal):", err);
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
    const rejectedCampaignIds = new Set<string>();

    const signerAddress = await wallet.getAddress();
    const nonceBefore = await provider.getTransactionCount(signerAddress);
    console.log(`[DATUM] Auto-flush: submitting ${batches.length} batch(es) for ${userAddress.slice(0, 10)}…`);
    // Paseo pallet-revive: explicit gas opts required
    await attestationVerifier.settleClaimsAttested(attestedBatches, {
      gasLimit: 500_000_000n,
      type: 0,
      gasPrice: 1_000_000_000_000n,
    });
    // Nonce poll — Paseo getTransactionReceipt returns null for confirmed txs
    for (let i = 0; i < 60; i++) {
      const current = await provider.getTransactionCount(signerAddress);
      if (current > nonceBefore) { console.log(`[DATUM] Auto-flush: tx confirmed (poll ${i + 1})`); break; }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Verify on-chain lastNonce per campaign to determine what settled/rejected
    const settlement = getSettlementContract(settings.contractAddresses, provider);
    const settledNonces = new Map<string, bigint[]>();
    for (const b of batches) {
      const cid = b.campaignId.toString();
      try {
        const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId);
        console.log(`[DATUM] Auto-flush: campaign=${cid} on-chain nonce=${onChainNonce}, batch first=${b.claims[0].nonce} last=${b.claims[b.claims.length - 1].nonce}`);
        if (onChainNonce >= b.claims[0].nonce) {
          const count = Number(onChainNonce - b.claims[0].nonce + 1n);
          const settled = b.claims.slice(0, count);
          settledNonces.set(cid, settled.map((c) => c.nonce));
          settledCount += settled.length;
          if (count < b.claims.length) {
            rejectedCampaignIds.add(cid);
            rejectedCount += b.claims.length - count;
          }
        } else {
          rejectedCampaignIds.add(cid);
          rejectedCount += b.claims.length;
        }
      } catch (e) {
        // RPC error — optimistically treat as settled
        console.warn(`[DATUM] Auto-flush: lastNonce check failed for campaign ${cid}, treating as settled:`, e);
        settledNonces.set(cid, b.claims.map((c) => c.nonce));
        settledCount += b.claims.length;
      }
    }

    if (settledCount > 0) {
      await claimQueue.removeSettled(userAddress, settledNonces);
      // Auto-sweep: if configured and threshold exceeded, sweep earnings to cold wallet
      await tryAutoSweep(settings, wallet, userAddress);
    }

    // Reset chain state for any campaign with rejected claims so future impressions
    // don't extend from a permanently invalid hash chain.
    for (const campaignId of rejectedCampaignIds) {
      await claimQueue.discardCampaignClaims(userAddress, campaignId);
      // Fetch on-chain nonce+hash so next impression starts from the correct base
      try {
        const [onChainNonce, onChainHash]: [bigint, string] = await Promise.all([
          settlement.lastNonce(userAddress, campaignId),
          settlement.lastClaimHash(userAddress, campaignId),
        ]);
        console.log(`[DATUM] Auto-flush: reset chain for campaign=${campaignId} to on-chain nonce=${onChainNonce}`);
        await claimBuilder.syncFromChain(userAddress, campaignId, Number(onChainNonce), onChainHash);
      } catch {
        // RPC failure — leave chain state intact rather than resetting to (0, ZeroHash).
        // Resetting corrupts the hash chain if prior settlements exist on-chain.
        console.warn(`[DATUM] Auto-flush: could not fetch on-chain state for campaign=${campaignId}, preserving existing chain state`);
      }
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
