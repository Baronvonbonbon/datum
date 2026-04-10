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

import { Wallet, solidityPacked, ZeroHash } from "ethers";
import { blake2b } from "@noble/hashes/blake2b";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auction: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _matcher: any = null;

let _mutexHeld = false;

// Last IMPRESSION_RECORDED result — exposed via getDebugInfo for the demo panel.
let _lastImpressionResult: { ok: boolean; reason?: string; campaignId?: string; user?: string; ts: number } | null = null;

// ── In-page relay signer ───────────────────────────────────────────────────
// Generates (or restores) an ephemeral EIP-712 signing wallet so the demo
// page can attest impressions without an external relay server.
// The key is persisted in localStorage under the datum_ext: namespace.

const RELAY_SIGNER_LS_KEY = "datum_ext:relaySignerKey";
// Paseo testnet chain ID
const PASEO_CHAIN_ID = 420420417n;

let _relayWallet: Wallet | null = null;

function loadOrCreateRelayWallet(): Wallet {
  if (_relayWallet) return _relayWallet;
  const stored = localStorage.getItem(RELAY_SIGNER_LS_KEY);
  if (stored) {
    try {
      _relayWallet = new Wallet(stored);
      return _relayWallet;
    } catch { /* invalid stored key — regenerate */ }
  }
  _relayWallet = Wallet.createRandom();
  localStorage.setItem(RELAY_SIGNER_LS_KEY, _relayWallet.privateKey);
  return _relayWallet;
}

async function signPublisherAttestation(
  campaignId: string,
  user: string,
  firstNonce: string,
  lastNonce: string,
  claimCount: number,
  relayAddress: string,
): Promise<string> {
  const wallet = loadOrCreateRelayWallet();
  const domain = {
    name: "DatumRelay",
    version: "1",
    chainId: PASEO_CHAIN_ID,
    verifyingContract: relayAddress as `0x${string}`,
  };
  const types = {
    PublisherAttestation: [
      { name: "campaignId", type: "uint256" },
      { name: "user",       type: "address" },
      { name: "firstNonce", type: "uint256" },
      { name: "lastNonce",  type: "uint256" },
      { name: "claimCount", type: "uint256" },
    ],
  };
  const value = {
    campaignId: BigInt(campaignId),
    user,
    firstNonce: BigInt(firstNonce),
    lastNonce: BigInt(lastNonce),
    claimCount: BigInt(claimCount),
  };
  return wallet.signTypedData(domain, types, value);
}

/** Get the relay signer wallet address (creates one if none exists). */
export function getRelaySignerAddress(): string {
  return loadOrCreateRelayWallet().address;
}

/** Import a custom relay signer private key. Returns false if invalid. */
export function importRelaySignerKey(privateKey: string): boolean {
  try {
    _relayWallet = new Wallet(privateKey);
    localStorage.setItem(RELAY_SIGNER_LS_KEY, _relayWallet.privateKey);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonDebugInfo {
  pollLastBlock: number | null;
  campaignIndexCount: number;
  activeCampaignsCount: number;
  pollerCampaignsAddr: string;
  sampleCampaign: { id: string; status: string; publisher: string } | null;
  connectedAddress: string | null;
  claimQueueCount: number;
  claimQueueAddresses: string[];
  lastImpressionResult: { ok: boolean; reason?: string; campaignId?: string; user?: string; ts: number } | null;
}

/** Read raw poller storage state — used by the demo debug panel. */
export async function getDebugInfo(): Promise<DaemonDebugInfo> {
  const stored = await chrome.storage.local.get([
    "pollLastBlock", "campaignIndex", "activeCampaigns", "pollerCampaignsAddr", "connectedAddress", "claimQueue",
  ]);
  const index: Record<string, any> = stored.campaignIndex ?? {};
  const active: any[] = stored.activeCampaigns ?? [];
  const queue: any[] = stored.claimQueue ?? [];
  const sample = active[0] ?? Object.values(index)[0] ?? null;
  const addrSet = new Set<string>(queue.map((c: any) => c.userAddress).filter(Boolean));
  return {
    pollLastBlock: stored.pollLastBlock ?? null,
    campaignIndexCount: Object.keys(index).length,
    activeCampaignsCount: active.length,
    pollerCampaignsAddr: stored.pollerCampaignsAddr ?? "",
    sampleCampaign: sample ? { id: sample.id, status: sample.status, publisher: sample.publisher } : null,
    connectedAddress: stored.connectedAddress ?? null,
    claimQueueCount: queue.length,
    claimQueueAddresses: [...addrSet],
    lastImpressionResult: _lastImpressionResult,
  };
}

/** Return the number of campaigns currently in the local cache. */
export async function getCampaignCount(): Promise<number> {
  if (!_poller) return 0;
  const cached = await _poller.getCachedSerialized();
  return cached.length;
}

/** Clear the poller scan state and re-run a full campaign poll from the deploy block. */
export async function repollCampaigns(): Promise<number> {
  if (!_poller) return 0;
  const stored = await chrome.storage.local.get("settings");
  const s = stored.settings;
  if (!s?.rpcUrl || !s?.contractAddresses?.campaigns) return 0;
  await _poller.reset();
  // Re-seed from deploy block so repoll doesn't scan from block 0
  const fb: number | undefined = (s.contractAddresses as any).fromBlock;
  if (fb) await chrome.storage.local.set({ pollLastBlock: fb - 1 });
  await _poller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway);
  const cached = await _poller.getCachedSerialized();
  console.log(`[datum-daemon] repoll complete: ${cached.length} campaigns`);
  return cached.length;
}

// ── Claim batch serialization ──────────────────────────────────────────────
// claimQueue.buildBatches() returns ClaimBatch[] with BigInt fields.
// chrome.runtime.sendMessage can't carry BigInt — serialize to strings.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeClaimBatches(batches: any[]): any[] {
  return batches.map((b) => ({
    user: b.user,
    campaignId: b.campaignId.toString(),
    claims: b.claims.map((c: any) => ({
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

// ── Message handler ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMessage(msg: any): Promise<unknown> {
  switch (msg.type) {
    // ── Campaigns ──────────────────────────────────────────────────────────
    case "GET_ACTIVE_CAMPAIGNS": {
      const cached = _poller ? await _poller.getCachedSerialized() : [];
      console.log(`[daemon] GET_ACTIVE_CAMPAIGNS: ${cached.length} campaigns`,
        cached.length > 0 ? `(sample: id=${cached[0].id} status=${cached[0].status} publisher=${cached[0].publisher})` : "");
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
      const batches = await _queue.buildBatches(msg.userAddress);
      return { batches: serializeClaimBatches(batches) };
    }

    case "SUBMIT_CAMPAIGN_CLAIMS": {
      if (!_queue) return { batch: null };
      const batch = await _queue.buildBatchForCampaign(msg.userAddress, msg.campaignId);
      if (!batch) return { batch: null };
      return { batch: serializeClaimBatches([batch])[0] };
    }

    case "DISCARD_CAMPAIGN_CLAIMS": {
      if (_queue) await _queue.discardCampaignClaims(msg.userAddress, msg.campaignId);
      return { ok: true };
    }

    case "DISCARD_REJECTED_CLAIMS": {
      if (_queue) {
        for (const campaignId of msg.campaignIds ?? []) {
          await _queue.discardCampaignClaims(msg.userAddress, campaignId);
        }
      }
      return { ok: true };
    }

    case "REMOVE_SETTLED_CLAIMS": {
      if (_queue) {
        // msg.settledNonces is Record<string, string[]> from JSON — convert to Map<string, bigint[]>
        const noncesMap = new Map<string, bigint[]>(
          Object.entries(msg.settledNonces ?? {}).map(([cid, nonces]) => [
            cid, (nonces as string[]).map((n) => BigInt(n)),
          ])
        );
        await _queue.removeSettled(msg.userAddress, noncesMap);
      }
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

    // ── Publisher attestation — signed locally by the in-page relay wallet ─
    case "REQUEST_PUBLISHER_ATTESTATION": {
      try {
        const stored = await chrome.storage.local.get("settings");
        const relayAddr: string = stored.settings?.contractAddresses?.relay
          ?? "0xFDF0dD9f81d1139Cb3CBc00b2CeeDE2dCdc97173"; // fallback: Paseo deployed address
        const sig = await signPublisherAttestation(
          msg.campaignId, msg.userAddress,
          msg.firstNonce, msg.lastNonce, msg.claimCount,
          relayAddr,
        );
        return { signature: sig };
      } catch (err) {
        return { signature: undefined, error: String(err) };
      }
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

    // ── Auction + campaign selection ───────────────────────────────────────
    case "SELECT_CAMPAIGN": {
      const prefs = _prefs ? await _prefs.getPreferences() : defaultPreferences();
      const allowed = (msg.campaigns ?? []).filter((c: any) =>
        _prefs ? _prefs.isCampaignAllowed(
          { id: c.id, categoryId: Number(c.categoryId ?? 0), bidCpmPlanck: c.bidCpmPlanck, requiredTags: c.requiredTags },
          prefs,
        ) : true
      );
      if (allowed.length === 0) return { selected: null };

      const profile = _interest ? await _interest.getProfile() : { weights: {}, visitCounts: {} };

      if (_auction) {
        const auctionResult = _auction.auctionForPage(allowed, {}, profile);
        if (auctionResult) {
          return {
            selected: auctionResult.winner,
            clearingCpmPlanck: auctionResult.clearingCpmPlanck.toString(),
            mechanism: auctionResult.mechanism,
            participants: auctionResult.participants,
          };
        }
      }

      // Fallback to weighted random matcher
      const selected = _matcher ? _matcher.selectCampaign(allowed, profile, msg.pageCategory ?? "") : allowed[0] ?? null;
      return { selected };
    }

    case "CHECK_PUBLISHER_ALLOWLIST":
      // In demo context: no on-chain allowlist check — conservative allow
      return { allowlistEnabled: false };

    case "FETCH_IPFS_METADATA": {
      const { campaignId: cid, metadataHash: mHash } = msg;
      if (!cid || !mHash) return { metadata: null };

      const storedSettings = await chrome.storage.local.get("settings");
      const primaryGateway = storedSettings.settings?.ipfsGateway || "https://dweb.link/ipfs/";
      const gateways = [primaryGateway, "https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];

      try {
        const [{ metadataUrl }, { validateAndSanitize, passesContentBlocklist }] = await Promise.all([
          import("@ext/shared/ipfs"),
          import("@ext/shared/contentSafety"),
        ]);
        for (const gw of gateways) {
          const url = metadataUrl(mHash, gw);
          if (!url) continue;
          try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!resp.ok) continue;
            const body = await resp.text();
            if (body.length > 512_000) return { metadata: null };
            const meta = validateAndSanitize(JSON.parse(body));
            if (!meta || !passesContentBlocklist(meta)) return { metadata: null };
            await chrome.storage.local.set({ [`metadata:${cid}`]: meta });
            return { metadata: meta };
          } catch { continue; }
        }
      } catch (e) {
        console.warn("[daemon] FETCH_IPFS_METADATA error:", e);
      }
      return { metadata: null };
    }

    case "IMPRESSION_RECORDED": {
      // claimBuilder.ts is excluded from the daemon because it imports zkProof.ts which
      // needs snarkjs (not bundled in the web app). Inline the essential claim-building
      // here using blake2b from @noble/hashes (available in web/node_modules).
      try {
        const s2 = await chrome.storage.local.get(["connectedAddress", "activeCampaigns"]);
        const userAddress: string | undefined = s2.connectedAddress;
        if (!userAddress) {
          _lastImpressionResult = { ok: false, reason: "no_wallet", ts: Date.now() };
          return { ok: false, reason: "no_wallet" };
        }

        const campaigns: any[] = s2.activeCampaigns ?? [];
        const campaign = campaigns.find((c: any) => c.id === String(msg.campaignId));
        if (!campaign) {
          console.warn(`[datum-daemon] IMPRESSION_RECORDED: campaign ${msg.campaignId} not in cache`);
          _lastImpressionResult = { ok: false, reason: `no_campaign(id=${msg.campaignId},cache=${campaigns.length})`, ts: Date.now() };
          return { ok: false, reason: "no_campaign" };
        }

        const CHAIN_KEY = `chainState:${userAddress}:${msg.campaignId}`;
        const qs = await chrome.storage.local.get([CHAIN_KEY, "claimQueue"]);
        const chain = qs[CHAIN_KEY] ?? { lastNonce: 0, lastClaimHash: ZeroHash };

        const campaignIdBig = BigInt(msg.campaignId);
        const nonce = BigInt(chain.lastNonce + 1);
        const prevHash: string = chain.lastNonce === 0 ? ZeroHash : chain.lastClaimHash;
        const clearingCpm = msg.clearingCpmPlanck
          ? BigInt(msg.clearingCpmPlanck)
          : BigInt(campaign.bidCpmPlanck ?? "0");

        // Blake2-256 matching Settlement._validateClaim() field order:
        // (campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)
        const packed = solidityPacked(
          ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
          [campaignIdBig, msg.publisherAddress, userAddress, 1n, clearingCpm, nonce, prevHash]
        );
        const packedBytes = new Uint8Array(Buffer.from(packed.slice(2), "hex"));
        const hashBytes = blake2b(packedBytes, { dkLen: 32 });
        const claimHash = "0x" + Array.from(hashBytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");

        await chrome.storage.local.set({
          [CHAIN_KEY]: { userAddress, campaignId: msg.campaignId, lastNonce: Number(nonce), lastClaimHash: claimHash },
        });

        const queue: any[] = qs.claimQueue ?? [];
        queue.push({
          campaignId: msg.campaignId,
          publisher: msg.publisherAddress,
          impressionCount: "1",
          clearingCpmPlanck: clearingCpm.toString(),
          nonce: nonce.toString(),
          previousClaimHash: prevHash,
          claimHash,
          zkProof: "0x",
          userAddress,
        });
        await chrome.storage.local.set({ claimQueue: queue });
        _lastImpressionResult = { ok: true, campaignId: String(msg.campaignId), user: userAddress.slice(0, 10), ts: Date.now() };
        console.log(`[datum-daemon] Claim queued: campaign=${msg.campaignId} nonce=${nonce} user=${userAddress.slice(0, 8)}…`);
        return { ok: true };
      } catch (err) {
        _lastImpressionResult = { ok: false, reason: String(err), ts: Date.now() };
        console.error("[datum-daemon] IMPRESSION_RECORDED error:", err);
        return { ok: false, reason: String(err) };
      }
    }

    case "UPDATE_INTEREST": {
      if (_interest) await _interest.updateProfile(msg.tags ?? []);
      return { ok: true };
    }

    case "SET_PUBLISHER_RELAY":
      // No-op in demo (relay mapping not needed)
      return { ok: true };

    case "GET_RELAY_SIGNER":
      return { address: getRelaySignerAddress() };

    case "SET_RELAY_SIGNER_KEY": {
      const ok = importRelaySignerKey(msg.privateKey ?? "");
      return { ok, address: ok ? getRelaySignerAddress() : undefined };
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
    { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag, isCampaignAllowed },
    { interestProfile },
    { requestPublisherAttestation },
    auctionMod,
    matcherMod,
  ] = await Promise.all([
    import("@ext/background/campaignPoller"),
    import("@ext/background/claimQueue"),
    import("@ext/background/userPreferences"),
    import("@ext/background/interestProfile"),
    import("@ext/background/publisherAttestation"),
    import("@ext/background/auction"),
    import("@ext/background/campaignMatcher"),
  ]);

  _poller    = campaignPoller;
  _queue     = claimQueue;
  _prefs     = { getPreferences, updatePreferences, blockCampaign, unblockCampaign, blockTag, unblockTag, isCampaignAllowed };
  _interest  = interestProfile;
  _attest    = { requestPublisherAttestation };
  _auction   = auctionMod;
  _matcher   = matcherMod;

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

  // Always refresh contract addresses from deployed-addresses.json so stale
  // localStorage from a previous deployment never blocks the poller.
  try {
    const resp = await fetch("/deployed-addresses.json");
    if (resp.ok) {
      const addrs = await resp.json();
      const merged = { ...existing, contractAddresses: { ...existing.contractAddresses, ...addrs } };
      await chrome.storage.local.set({ settings: merged });
      console.log("[datum-daemon] contract addresses refreshed from deployed-addresses.json");

      // If deployed-addresses.json includes a fromBlock hint and the poller has no
      // stored lastBlock yet, seed it so the first scan starts from the deploy block
      // rather than block 0 (scanning 7M+ blocks is 700+ RPC calls and takes minutes).
      const fromBlock: number | undefined = typeof addrs.fromBlock === "number" ? addrs.fromBlock : undefined;
      if (fromBlock) {
        const stored2 = await chrome.storage.local.get("pollLastBlock");
        // Always update if stored block is below the deploy block — this covers
        // stale localStorage from runs before fromBlock seeding was added.
        if (!stored2.pollLastBlock || Number(stored2.pollLastBlock) < fromBlock - 1) {
          await chrome.storage.local.set({ pollLastBlock: fromBlock - 1 });
          console.log(`[datum-daemon] seeded pollLastBlock=${fromBlock - 1} from deployed-addresses.json`);
        }
      }
    } else {
      await chrome.storage.local.set({ settings: existing });
    }
  } catch (e) {
    console.warn("[datum-daemon] could not load deployed-addresses.json", e);
    await chrome.storage.local.set({ settings: existing });
  }

  // Kick off first campaign poll in the background — do NOT await so the daemon
  // resolves immediately and the UI stops showing "Starting extension daemon…".
  // The bridge and popup will pick up campaigns once the poll completes.
  (async () => {
    try {
      const s = (await chrome.storage.local.get("settings")).settings;
      if (s?.rpcUrl && s?.contractAddresses?.campaigns) {
        // Reset scan cursor if:
        //  - No campaigns cached (previous run may have been broken), OR
        //  - The stored campaigns address differs from the freshly-loaded one
        //    (new deployment — old cached events came from the wrong contract).
        const preCached = await campaignPoller.getCachedSerialized();
        const cachedAddr = (await chrome.storage.local.get("pollerCampaignsAddr")).pollerCampaignsAddr ?? "";
        if (preCached.length === 0 || cachedAddr.toLowerCase() !== s.contractAddresses.campaigns.toLowerCase()) {
          console.log("[datum-daemon] resetting poller — campaigns address changed or cache empty");
          await campaignPoller.reset();
          await chrome.storage.local.set({ pollerCampaignsAddr: s.contractAddresses.campaigns });
          // Re-seed pollLastBlock to fromBlock so the reset scan doesn't start from 0
          const fb: number | undefined = (s.contractAddresses as any).fromBlock;
          if (fb) {
            await chrome.storage.local.set({ pollLastBlock: fb - 1 });
            console.log(`[datum-daemon] re-seeded pollLastBlock=${fb - 1} after reset`);
          }
        }
        console.log("[datum-daemon] starting campaign poll (background)");
        await campaignPoller.poll(s.rpcUrl, s.contractAddresses, s.ipfsGateway);
        const cached = await campaignPoller.getCachedSerialized();
        console.log(`[datum-daemon] poll complete: ${cached.length} campaigns loaded`);
        if (cached.length > 0) {
          console.log(`[datum-daemon] sample: id=${cached[0].id} status=${cached[0].status} publisher=${cached[0].publisher}`);
        }
      } else {
        console.warn("[datum-daemon] missing rpcUrl or campaigns address — skipping poll", {
          rpcUrl: s?.rpcUrl,
          campaigns: s?.contractAddresses?.campaigns,
        });
      }
    } catch (e) {
      console.warn("[datum-daemon] initial poll failed:", e);
    }
  })();
}
