// DATUM message router — the SINGLE source of truth for message-type → handler
// logic. Both the service worker (`background/index.ts`) and the demo daemon
// (`web/src/lib/extensionDaemon.ts`) call `routeMessage(msg, sender, env)` so the
// two can no longer drift (which silently broke the demo repeatedly — see
// web/DEMO-DAEMON-REFACTOR.md).
//
// Environment differences (read provider, offscreen transport, earnings indexer,
// alarms, auto-submit session, EIP-1193 signing, publisher attestation) are
// injected via `EnvContext` — they are NOT branched per message. Everything that
// is genuinely identical across both contexts (the claim queue, poller, prefs,
// interest profile, contracts, content-safety) is imported directly here.
//
// This module MUST stay free of import-time side effects and of anything that
// only the service worker has (alarms, onInstalled, idle-lock, snarkjs). Those
// live in `index.ts`. claimBuilder is snarkjs-free (ZK is injected via
// setProveZk), so importing it here is safe for the web bundle.

import { JsonRpcProvider, JsonRpcApiProvider } from "ethers";
import { campaignPoller } from "./campaignPoller";
import { claimQueue } from "./claimQueue";
import { claimBuilder } from "./claimBuilder";
import { interestProfile } from "./interestProfile";
import { selectCampaign } from "./campaignMatcher";
import { auctionForPage, CampaignCandidate } from "./auction";
import { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag, isCampaignAllowed, checkRateLimit, recordImpressionTime } from "./userPreferences";
import { appendEvent } from "./behaviorChain";
import { computeQualityScore, meetsQualityThreshold } from "@shared/qualityScore";
import { timelockMonitor } from "./timelockMonitor";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { dispatchWalletRpc } from "./wallet/rpcDispatcher";
import { DEFAULT_SETTINGS, NETWORK_CONFIGS } from "@shared/networks";
import { ClaimBatch, SerializedClaimBatch, StoredSettings } from "@shared/types";
import { isAddressBlocked, isUrlPhishing } from "@shared/phishingList";
import { validateAndSanitize, passesContentBlocklist, MAX_METADATA_BYTES } from "@shared/contentSafety";
import { metadataUrl } from "@shared/ipfs";
import { tagStringFromHash } from "@shared/tagDictionary";
import { impressionLog } from "./impressionLog";
import { getSettlementContract, getCampaignsContract } from "@shared/contracts";

// -------------------------------------------------------------------------
// EnvContext — the seam. Captures everything that differs between the service
// worker and the demo daemon. Message handlers reach env-specific capability
// ONLY through this object.
// -------------------------------------------------------------------------

export interface ProviderOpts { rpcAllowed?: boolean }

export interface EnvContext {
  /** Read provider for contract reads. SW: getReadProvider → offscreen pine /
   *  JsonRpcProvider; demo: the page's own pine-backed provider. Returns the
   *  same `JsonRpcProvider | JsonRpcApiProvider` family the contracts getters
   *  accept (see shared/contracts.ts `type Provider`). */
  readProvider(settings: StoredSettings, opts?: ProviderOpts): Promise<JsonRpcApiProvider>;
  /** Pine light-client provider for the PROVIDER_RPC_PROXY safe-read path
   *  (null → caller falls back to a centralized JsonRpcProvider). */
  pineProvider(settings: StoredSettings): Promise<{ send(method: string, params: unknown[]): Promise<unknown> } | null>;
  /** History-tab earnings indexer. SW: live subscription + backfill; demo: no-op. */
  earnings: {
    start(opts: { rpcUrl: string; chainId: number; contractAddresses: StoredSettings["contractAddresses"]; userAddress: string }): Promise<void>;
    stop(): Promise<void>;
  };
  /** Settings-changed hook. SW: re-arm chrome.alarms; demo: no-op (shim alarms). */
  onSettingsUpdated(): Promise<void>;
  /** Auto-submit session key. SW: encrypt/decrypt with session password; demo: disabled. */
  autoSubmit: {
    authorize(password: string): Promise<void>;
    revoke(): Promise<void>;
    isAuthorized(): Promise<boolean>;
  };
  /** EIP-1193 provider signing + approval (SW only; demo stub — all PROVIDER_*
   *  sign paths are SW_ONLY because the demo injects no page provider). */
  signing: {
    signTypedData(msg: any, sender: chrome.runtime.MessageSender): Promise<{ signature?: string; error?: string }>;
    personalSign(msg: any, sender: chrome.runtime.MessageSender): Promise<{ signature?: string; error?: string }>;
    sendTransaction(msg: any, sender: chrome.runtime.MessageSender): Promise<{ hash?: string; error?: string }>;
    resolveApproval(msg: any): Promise<{ ok: boolean; error?: string }>;
  };
  /** Content-script EIP-1193 bridge (WALLET_PROVIDER_REQUEST). SW: handleProviderRequest; demo: stub. */
  walletProvider(msg: any, sender: chrome.runtime.MessageSender): Promise<unknown>;
  /** Publisher attestation. SW: relay fetch (claimsHash/deadlineBlock typehash);
   *  demo: local Diana key. Returns the cosignature or an error. */
  requestAttestation(args: {
    publisherAddress: string;
    campaignId: string;
    userAddress: string;
    claimsHash: string;
    deadlineBlock: string;
  }): Promise<{ signature?: string; error?: string }>;
}

// -------------------------------------------------------------------------
// Shared helpers (identical in both contexts).
// -------------------------------------------------------------------------

// Chain-id lookup for the History-tab earnings indexer. NETWORK_CONFIGS doesn't
// expose chainId, so keep a small mapping here.
const NETWORK_CHAIN_IDS: Record<string, number> = {
  polkadotTestnet: 420420417,
  paseoEvm: 420420422,
  local: 31337,
};
export function chainIdForNetwork(network: string): number {
  return NETWORK_CHAIN_IDS[network] ?? 0;
}

// Safe RPC methods that content scripts can proxy without approval.
const SAFE_RPC_METHODS = new Set([
  "eth_accounts", "eth_requestAccounts", "eth_chainId", "eth_blockNumber",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance",
  "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas",
  "eth_gasPrice", "eth_getTransactionCount", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "net_version", "web3_clientVersion",
]);

export async function getSettings(): Promise<StoredSettings> {
  const stored = await chrome.storage.local.get("settings");
  const s = (stored.settings as StoredSettings | undefined) ?? DEFAULT_SETTINGS;
  // Migration: existing users (pre-rpcEnabled-toggle) get rpcEnabled=true so
  // their current behaviour continues. Absence of the field is the marker for
  // "existed before the toggle". Only flip usePine when the field is absent.
  let migrated = false;
  if (s.rpcEnabled === undefined && stored.settings !== undefined) {
    s.rpcEnabled = true;
    migrated = true;
  }
  if (s.usePine === undefined && stored.settings !== undefined) {
    s.usePine = false;
    migrated = true;
  }
  if (migrated) {
    await chrome.storage.local.set({ settings: s });
    console.log("[DATUM] Migrated existing settings: rpcEnabled=true, usePine kept at legacy value");
  }
  return s;
}

// ClaimBatch contains bigints — serialize for chrome message passing (JSON).
export function serializeBatches(batches: ClaimBatch[]): SerializedClaimBatch[] {
  return batches.map((b) => ({
    user: b.user,
    campaignId: b.campaignId.toString(),
    claims: b.claims.map((c) => ({
      campaignId: c.campaignId.toString(),
      publisher: c.publisher,
      eventCount: c.eventCount.toString(),
      rateWei: c.rateWei.toString(),
      actionType: c.actionType.toString(),
      clickSessionHash: c.clickSessionHash,
      nonce: c.nonce.toString(),
      previousClaimHash: c.previousClaimHash,
      claimHash: c.claimHash,
      zkProof: c.zkProof,
      nullifier: c.nullifier,
      stakeRootUsed: c.stakeRootUsed,
      actionSig: c.actionSig,
      powNonce: c.powNonce,
    })),
  }));
}

// -------------------------------------------------------------------------
// The ONE message router.
// -------------------------------------------------------------------------

export async function routeMessage(
  msg: ContentToBackground | PopupToBackground,
  sender: chrome.runtime.MessageSender,
  env: EnvContext,
): Promise<unknown> {
  // Wallet RPC bypass — a single envelope so the popup can address ~15 wallet
  // ops without inflating the message union. See wallet/rpcDispatcher.ts.
  if (msg.type === "WALLET_RPC_REQUEST") {
    return dispatchWalletRpc(msg.requestId, msg.op, msg.args);
  }
  // EIP-1193 provider RPC from a content script — delegated to env so the SW
  // can enforce its origin/permission gate. The demo injects no page provider,
  // so this never arrives there (env stub).
  if (msg.type === "WALLET_PROVIDER_REQUEST") {
    return env.walletProvider(msg, sender);
  }

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

      // Contextual mode: ad shown, but no claim built (no rewards) and no profile update
      if (prefs.contextualMode) {
        console.log(`[DATUM] Contextual mode — impression shown for campaign ${msg.campaignId}, no claim built`);
        await impressionLog.add({
          campaignId: msg.campaignId,
          publisherAddress: msg.publisherAddress,
          rateWei: msg.clearingCpmWei ?? "0",
          actionType: 0,
          timestamp: Date.now(),
          url: msg.url,
        });
        return { ok: true, impressionNonce: null };
      }

      let impressionNonce: string | null = null;
      try {
        impressionNonce = await claimBuilder.onImpression(msg);
        console.log(`[DATUM] Claim built for campaign ${msg.campaignId}`);
      } catch (err) {
        console.error("[DATUM] claimBuilder.onImpression failed:", err);
        return { ok: false, reason: "claim_build_error" };
      }

      // Log impression to history
      await impressionLog.add({
        campaignId: msg.campaignId,
        publisherAddress: msg.publisherAddress,
        rateWei: msg.clearingCpmWei ?? "0",
        actionType: 0,
        timestamp: Date.now(),
        url: msg.url,
      });

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

      return { ok: true, impressionNonce };
    }

    case "AD_CLICK": {
      const cached = await chrome.storage.local.get("activeCampaigns");
      const campaigns: any[] = cached.activeCampaigns ?? [];
      const campaign = campaigns.find((c: any) => c.id === msg.campaignId);
      if (!campaign || !campaign.clickBid || campaign.clickBid === "0") {
        return { ok: false, reason: "no_click_pot" };
      }
      try {
        await claimBuilder.onClick({
          campaignId: msg.campaignId,
          publisherAddress: msg.publisherAddress,
          impressionNonce: msg.impressionNonce,
          rateWei: campaign.clickBid,
        });
        return { ok: true };
      } catch (err) {
        console.error("[DATUM] claimBuilder.onClick failed:", err);
        return { ok: false, reason: "claim_build_error" };
      }
    }

    case "REMOTE_ACTION": {
      const cached = await chrome.storage.local.get("activeCampaigns");
      const campaigns: any[] = cached.activeCampaigns ?? [];
      const campaign = campaigns.find((c: any) => c.id === msg.campaignId);
      if (!campaign || !campaign.actionBid || campaign.actionBid === "0") {
        return { ok: false, reason: "no_action_pot" };
      }

      // Fetch the actionVerifier address from the contract (type-2 pot)
      let actionVerifier: string = "";
      try {
        const settings = await getSettings();
        const addrs = settings.contractAddresses;
        if (addrs.campaigns) {
          const provider = await env.readProvider(settings);
          const contract = getCampaignsContract(addrs, provider);
          const pot = await contract.getCampaignPot(BigInt(msg.campaignId), 2);
          actionVerifier = pot?.actionVerifier ?? pot?.[4] ?? "";
        }
      } catch (err) {
        console.warn("[DATUM] REMOTE_ACTION: failed to fetch actionVerifier:", err);
        return { ok: false, reason: "verifier_fetch_failed" };
      }

      if (!actionVerifier || actionVerifier === "0x0000000000000000000000000000000000000000") {
        return { ok: false, reason: "no_action_verifier" };
      }

      // Fetch action signature from the publisher's relay (same relay domain as impressions)
      let actionSig = "0x";
      try {
        const relayKey = `publisherDomain:${msg.publisherAddress.toLowerCase()}`;
        const relayStored = await chrome.storage.local.get(relayKey);
        const relayDomain: string | undefined = relayStored[relayKey];
        if (relayDomain) {
          const userStored = await chrome.storage.local.get("connectedAddress");
          const userAddress: string = userStored.connectedAddress ?? "";
          const resp = await fetch(
            `https://${relayDomain}/action-sig?campaign=${msg.campaignId}&user=${userAddress}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (resp.ok) {
            const json = await resp.json();
            actionSig = json.sig ?? "0x";
          }
        }
      } catch (err) {
        console.warn("[DATUM] REMOTE_ACTION: relay sig fetch failed:", err);
        // Proceed with empty sig — settlement will reject if verifier is enforced
      }

      try {
        await claimBuilder.onRemoteAction({
          campaignId: msg.campaignId,
          publisherAddress: msg.publisherAddress,
          rateWei: campaign.actionBid,
          actionSig,
        });
        return { ok: true };
      } catch (err) {
        console.error("[DATUM] claimBuilder.onRemoteAction failed:", err);
        return { ok: false, reason: "claim_build_error" };
      }
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
        const provider = await env.readProvider(s);
        const contract = getPublishersContract(s.contractAddresses, provider);
        const result = await contract.allowlistEnabled(pubAddr);
        return { allowlistEnabled: !!result };
      } catch {
        return { allowlistEnabled: false };
      }
    }

    case "FETCH_IPFS_METADATA": {
      // Content script requests metadata fetch (background has no CSP restrictions)
      const { campaignId: cid, metadataHash: mHash, bulletinDigest, bulletinCodec } = msg as any;
      console.log(`[DATUM] FETCH_IPFS_METADATA: campaignId=${cid}, hash=${mHash}, bulletin=${bulletinDigest ?? "none"}`);
      if (!cid || (!mHash && !bulletinDigest)) return { metadata: null };
      const s = await getSettings();
      const primaryGateway = s.ipfsGateway || "https://dweb.link/ipfs/";

      // Phase A: try the Bulletin Chain Paseo gateway first when a digest is
      // present, then fall back to standard IPFS gateways using the legacy
      // metadataHash. If the content script didn't pass a Bulletin ref, look
      // it up on demand from the campaigns contract.
      const { bulletinGatewayUrl, BulletinCodec } = await import("@shared/bulletinChain");
      let effectiveDigest: string | undefined = bulletinDigest;
      let effectiveCodec: number = bulletinCodec ?? BulletinCodec.Raw;
      if (!effectiveDigest && s.contractAddresses?.campaigns) {
        try {
          const provider = await env.readProvider(s);
          const campaigns = getCampaignsContract(s.contractAddresses, provider);
          const ref: any = await campaigns.getBulletinCreative(BigInt(cid));
          effectiveDigest = (ref.cidDigest ?? ref[0]) as string;
          effectiveCodec = Number(ref.cidCodec ?? ref[1] ?? 0);
        } catch {
          // legacy deployment / RPC down — silently skip Bulletin path
        }
      }
      const candidates: string[] = [];
      if (effectiveDigest && effectiveDigest !== "0x" + "0".repeat(64)) {
        const bUrl = bulletinGatewayUrl(effectiveDigest, effectiveCodec as any);
        if (bUrl) candidates.push(bUrl);
      }
      const ipfsGateways = [
        primaryGateway,
        "https://ipfs.io/ipfs/",
        "https://cloudflare-ipfs.com/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
      ];
      const uniqueIpfsGateways = [...new Set(ipfsGateways.map(g => g.endsWith("/") ? g : g + "/"))];
      if (mHash) {
        for (const gw of uniqueIpfsGateways) {
          const u = metadataUrl(mHash, gw);
          if (u) candidates.push(u);
        }
      }

      for (const url of candidates) {
        let host = url;
        try { host = new URL(url).hostname; } catch { /* ignore */ }
        try {
          console.log(`[DATUM] FETCH_IPFS_METADATA: trying ${url}`);
          const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!resp.ok) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: ${host} returned ${resp.status}`);
            continue;
          }
          const bodyBytes = new Uint8Array(await resp.arrayBuffer());
          if (bodyBytes.length > MAX_METADATA_BYTES) {
            console.warn(`[DATUM] FETCH_IPFS_METADATA: body too large (${bodyBytes.length})`);
            return { metadata: null };
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
          console.log(`[DATUM] FETCH_IPFS_METADATA: success from ${host}`);
          return { metadata: meta };
        } catch (err) {
          console.warn(`[DATUM] FETCH_IPFS_METADATA: ${host} error:`, err);
          continue;
        }
      }
      console.warn(`[DATUM] FETCH_IPFS_METADATA: all gateways failed for campaign ${cid}`);
      return { metadata: null };
    }

    case "POLL_CAMPAIGNS": {
      const s = await getSettings();
      if (s.contractAddresses.campaigns) {
        await campaignPoller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway, s.usePine ? NETWORK_CONFIGS[s.network]?.pineChain : undefined, s.rpcEnabled ?? false);
        const refreshed = await campaignPoller.getCachedSerialized();
        const activeIds = new Set(refreshed.map((c) => c.id));
        const pruned = await claimQueue.pruneInactiveCampaigns(activeIds);
        if (pruned > 0) console.log(`[DATUM] Pruned ${pruned} stale claims after manual poll`);
        return { campaigns: refreshed, ok: true };
      }
      return { campaigns: [], error: "No campaigns contract address configured" };
    }

    case "EARNINGS_REFRESH_ONESHOT": {
      // One-shot historical earnings backfill. Temporarily enables RPC for the
      // duration of the scan; settings revert in finally so the user's posture
      // is preserved even if the scan errors.
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress: string | undefined = stored.connectedAddress;
      if (!userAddress) return { ok: false, error: "wallet-not-connected" };

      const s = await getSettings();
      if (!s.contractAddresses.settlement) {
        return { ok: false, error: "settlement-not-configured" };
      }
      const wasRpcEnabled = s.rpcEnabled ?? false;
      try {
        if (!wasRpcEnabled) {
          await chrome.storage.local.set({ settings: { ...s, rpcEnabled: true } });
        }
        await env.earnings.start({
          rpcUrl: s.rpcUrl,
          chainId: chainIdForNetwork(s.network),
          contractAddresses: s.contractAddresses,
          userAddress,
        });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
      } finally {
        if (!wasRpcEnabled) {
          const fresh = await chrome.storage.local.get("settings");
          const cur = (fresh.settings as StoredSettings) ?? s;
          await chrome.storage.local.set({ settings: { ...cur, rpcEnabled: false } });
        }
      }
    }

    case "WALLET_CONNECTED": {
      await chrome.storage.local.set({ connectedAddress: msg.address });
      // History tab — start the earnings indexer for the new wallet
      try {
        const s = await getSettings();
        if (s.contractAddresses.settlement) {
          await env.earnings.start({
            rpcUrl: s.rpcUrl,
            chainId: chainIdForNetwork(s.network),
            contractAddresses: s.contractAddresses,
            userAddress: msg.address,
          });
        }
      } catch (err) {
        console.warn("[DATUM] Earnings listener (WALLET_CONNECTED) failed:", err);
      }
      return { ok: true };
    }

    case "WALLET_DISCONNECTED": {
      const stored = await chrome.storage.local.get("connectedAddress");
      const prevAddress: string | undefined = stored.connectedAddress;
      await chrome.storage.local.remove("connectedAddress");
      if (prevAddress) {
        try {
          await env.earnings.stop();
        } catch { /* shutdown — non-fatal */ }
      }
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
      try {
        const s = await getSettings();
        const p = await env.readProvider(s);
        const stl = getSettlementContract(s.contractAddresses, p);
        const [onChainNonce, onChainHash] = await Promise.all([
          stl.lastNonce(msg.userAddress, msg.campaignId),
          stl.lastClaimHash(msg.userAddress, msg.campaignId),
        ]);
        await claimBuilder.syncFromChain(msg.userAddress, msg.campaignId, Number(onChainNonce), onChainHash);
      } catch {
        console.warn("[DATUM] DISCARD_CAMPAIGN_CLAIMS: RPC failed, preserving existing chain state");
      }
      return { removed };
    }

    case "DISCARD_REJECTED_CLAIMS": {
      // Triggered by offscreen after on-chain verification of a settlement tx.
      const s = await getSettings();
      const p = await env.readProvider(s);
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
      await env.onSettingsUpdated();
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
          (nonces as string[]).map((n) => BigInt(n)),
        ])
      );
      await claimQueue.removeSettled(msg.userAddress, settledNonces);
      return { ok: true };
    }

    case "PRUNE_SETTLED_UP_TO_NONCE": {
      await claimQueue.removeSettledUpToNonce(msg.userAddress, msg.campaignId, BigInt(msg.upToNonce));
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
      const interestPrefs = await getPreferences();
      // Contextual mode: do not record page visits or ad exposure into the profile
      if (!interestPrefs.contextualMode) {
        if ((msg.delta ?? 1) < 0) {
          await interestProfile.removeRecentVisits(msg.tags ?? []);
        } else {
          await interestProfile.updateProfile(msg.tags ?? []);
        }
      }
      return { ok: true };
    }

    case "SELECT_CAMPAIGN": {
      // Filter through user preferences first
      const prefs = await getPreferences();
      const allowed = msg.campaigns.filter((c: any) =>
        isCampaignAllowed(
          { id: c.id, categoryId: Number(c.categoryId ?? 0), viewBid: c.viewBid, requiredTags: c.requiredTags },
          prefs,
        )
      );

      if (allowed.length === 0) return { selected: null };

      // Filter out campaigns with blocked advertiser/publisher addresses.
      // Also filter campaigns already assigned to another slot this page load.
      const excludedIds = new Set<string>(msg.excludedCampaignIds ?? []);
      const safeAllowed: typeof allowed = [];
      for (const c of allowed) {
        if (excludedIds.has(String(c.id))) continue;
        const advBlocked = await isAddressBlocked(c.advertiser ?? "");
        const pubBlocked = await isAddressBlocked(c.publisher ?? "");
        if (advBlocked || pubBlocked) {
          console.warn(`[DATUM] Campaign ${c.id} filtered — blocked address`);
          continue;
        }
        safeAllowed.push(c);
      }

      if (safeAllowed.length === 0) return { selected: null };

      // Build effective page tags: merge base page tags + format tag for this slot
      const profile = await interestProfile.getProfile();
      const pageTags: string[] = [...(msg.pageTags ?? [])];
      if (msg.slotFormat) pageTags.push(`format:${msg.slotFormat}`);

      const auctionResult = auctionForPage(
        safeAllowed as CampaignCandidate[],
        {},
        profile,
        pageTags,
        prefs.contextualMode,
      );

      if (auctionResult) {
        return {
          selected: auctionResult.winner,
          clearingCpmWei: auctionResult.clearingCpmWei.toString(),
          mechanism: auctionResult.mechanism,
          participants: auctionResult.participants,
          allBids: auctionResult.allScored,
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
      // A1-fix: attestation binds claimsHash + deadlineBlock instead of nonce-range fields.
      const attestResult = await env.requestAttestation({
        publisherAddress: msg.publisherAddress,
        campaignId: msg.campaignId,
        userAddress: msg.userAddress,
        claimsHash: msg.claimsHash,
        deadlineBlock: msg.deadlineBlock,
      });
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
      if (!s.contractAddresses.campaigns) return { ok: false, error: "Campaigns contract not configured" };
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress: string | undefined = stored.connectedAddress;
      if (!userAddress) return { ok: false, error: "Wallet not connected" };
      try {
        const { getCampaignsContract: getCampaignsC } = await import("@shared/contracts");
        const { getSigner: getWalletSigner } = await import("@shared/walletManager");
        const _baseProvider = await env.readProvider(s);
        const _wallet = getWalletSigner(s.rpcUrl);
        const signer = _wallet.connect(_baseProvider);
        const campaigns = getCampaignsC(s.contractAddresses, signer);
        const fn = msg.type === "REPORT_PAGE" ? campaigns.reportPage : campaigns.reportAd;
        const tx = await fn(BigInt(msg.campaignId), msg.reason);
        await tx.wait();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err).slice(0, 120) };
      }
    }

    // Engagement tracking — quality score computed here (trusted background).
    case "ENGAGEMENT_RECORDED": {
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress = stored.connectedAddress;
      if (userAddress && msg.event) {
        await appendEvent(userAddress, msg.event);

        const qualityScore = computeQualityScore(msg.event);
        if (!meetsQualityThreshold(msg.event)) {
          const qStored = await chrome.storage.local.get("claimQueue");
          const queue: any[] = qStored.claimQueue ?? [];
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
      await env.autoSubmit.authorize(msg.password);
      return { ok: true };
    }

    case "REVOKE_AUTO_SUBMIT": {
      await env.autoSubmit.revoke();
      return { ok: true };
    }

    case "CHECK_AUTO_SUBMIT": {
      const authorized = await env.autoSubmit.isAuthorized();
      return { authorized };
    }

    // H2: Timelock pending changes
    case "GET_TIMELOCK_PENDING": {
      const pending = await timelockMonitor.getPending();
      return { pending };
    }

    // Legacy: ENGAGEMENT_QUALITY_RESULT no longer sent by content script.
    case "ENGAGEMENT_QUALITY_RESULT": {
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    // window.datum provider bridge (content/provider.ts → EIP-1193 proxy)
    // -----------------------------------------------------------------------

    case "PROVIDER_GET_ADDRESS": {
      const stored = await chrome.storage.local.get(["connectedAddress", "activeWalletName"]);
      if (stored.connectedAddress) return { address: stored.connectedAddress };
      if (stored.activeWalletName) {
        const { listWallets } = await import("@shared/walletManager");
        const wallets = await listWallets();
        const active = wallets.find((w) => w.name === stored.activeWalletName);
        if (active) {
          await chrome.storage.local.set({ connectedAddress: active.address });
          return { address: active.address };
        }
      }
      return { address: null };
    }

    case "PROVIDER_GET_CHAIN_ID": {
      const s = await getSettings();
      try {
        const provider = await env.readProvider(s);
        const network = await provider.getNetwork();
        return { chainId: "0x" + network.chainId.toString(16) };
      } catch {
        return { chainId: "0x1" };
      }
    }

    case "PROVIDER_SIGN_TYPED_DATA":
      return env.signing.signTypedData(msg, sender);

    case "PROVIDER_PERSONAL_SIGN":
      return env.signing.personalSign(msg, sender);

    case "PROVIDER_SEND_TRANSACTION":
      return env.signing.sendTransaction(msg, sender);

    case "PROVIDER_RPC_PROXY": {
      // Only allow safe read-only RPC methods.
      if (!SAFE_RPC_METHODS.has(msg.method)) {
        return { error: `RPC method '${msg.method}' is not allowed through the provider bridge.` };
      }
      const s2 = await getSettings();
      try {
        const pineProvider = await env.pineProvider(s2);
        if (pineProvider) {
          const result = await pineProvider.send(msg.method, msg.params ?? []);
          return { result };
        }
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

    case "PROVIDER_APPROVAL_RESPONSE":
      return env.signing.resolveApproval(msg);

    case "GET_IMPRESSION_LOG": {
      const log = await impressionLog.getAll();
      return { log };
    }

    case "CLEAR_IMPRESSION_LOG": {
      await impressionLog.clear();
      return { ok: true };
    }

    default:
      return { error: "unknown message type" };
  }
}
