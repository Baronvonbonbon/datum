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

import { Wallet, JsonRpcProvider, solidityPacked, ZeroHash, getBytes } from "ethers";
import { blake2b } from "@noble/hashes/blake2b";
import { installChromeShim } from "./chromeShim";
import { getSettlementContract, getClaimValidatorContract } from "@shared/contracts";

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
// Uses Diana's testnet key as the demo relay signer so that
// REQUEST_PUBLISHER_ATTESTATION produces a valid EIP-712 signature for
// all seeded test campaigns (which have diana.address as their relaySigner).
// The key is persisted in localStorage under the datum_ext: namespace so
// an operator can override it at runtime via SET_RELAY_SIGNER_KEY.

const RELAY_SIGNER_LS_KEY = "datum_ext:relaySignerKey";
// Paseo testnet chain ID
const PASEO_CHAIN_ID = 420420417n;
// Default relay signer: Diana (Publisher 1 on Paseo testnet).
// All seeded campaigns have diana.address as their on-chain relaySigner.
const DIANA_RELAY_KEY = "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0";

let _relayWallet: Wallet | null = null;

function loadOrCreateRelayWallet(): Wallet {
  if (_relayWallet) return _relayWallet;
  // Always use Diana's testnet key — ignore any previously stored key so
  // the in-page signer always matches the on-chain relaySigner for all
  // seeded campaigns. This is a public testnet key, not a secret.
  _relayWallet = new Wallet(DIANA_RELAY_KEY);
  localStorage.setItem(RELAY_SIGNER_LS_KEY, _relayWallet.privateKey);
  return _relayWallet;
}

async function signPublisherAttestation(
  campaignId: string,
  user: string,
  firstNonce: string,
  lastNonce: string,
  claimCount: number,
  attestationVerifierAddress: string,
  signingWallet?: Wallet,
): Promise<string> {
  const wallet = signingWallet ?? loadOrCreateRelayWallet();
  const domain = {
    name: "DatumAttestationVerifier",
    version: "1",
    chainId: PASEO_CHAIN_ID,
    verifyingContract: attestationVerifierAddress as `0x${string}`,
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
  relaySignerAddress: string;
  claimBuilderMode: "per-impression" | "aggregated";
  rawQueueDepth: number;
}

/** Read raw poller storage state — used by the demo debug panel. */
export async function getDebugInfo(): Promise<DaemonDebugInfo> {
  const stored = await chrome.storage.local.get([
    "pollLastBlock", "campaignIndex", "activeCampaigns", "pollerCampaignsAddr", "connectedAddress",
    "claimQueue", "rawImpressionQueue", "claimBuilderMode",
  ]);
  const index: Record<string, any> = stored.campaignIndex ?? {};
  const active: any[] = stored.activeCampaigns ?? [];
  const queue: any[] = stored.claimQueue ?? [];
  const rawQueue: any[] = stored.rawImpressionQueue ?? [];
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
    relaySignerAddress: getRelaySignerAddress(),
    claimBuilderMode: (stored.claimBuilderMode ?? "per-impression") as "per-impression" | "aggregated",
    rawQueueDepth: rawQueue.length,
  };
}

/** Toggle the claim builder mode between per-impression (eager hashing) and aggregated (lazy). */
export async function setClaimBuilderMode(mode: "per-impression" | "aggregated"): Promise<void> {
  await chrome.storage.local.set({ claimBuilderMode: mode });
  console.log(`[datum-daemon] Claim builder mode set to: ${mode}`);
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
      if (_queue) {
        await _queue.discardCampaignClaims(msg.userAddress, msg.campaignId);
        const chainKey = `chainState:${msg.userAddress}:${msg.campaignId}`;
        try {
          const s2 = (await chrome.storage.local.get("settings")).settings;
          const p2 = new JsonRpcProvider(s2?.rpcUrl ?? "https://eth-rpc-testnet.polkadot.io/");
          const stl2 = getSettlementContract(s2?.contractAddresses, p2);
          const [n2, h2] = await Promise.all([
            stl2.lastNonce(msg.userAddress, msg.campaignId),
            stl2.lastClaimHash(msg.userAddress, msg.campaignId),
          ]);
          await chrome.storage.local.set({ [chainKey]: { userAddress: msg.userAddress, campaignId: msg.campaignId, lastNonce: Number(n2), lastClaimHash: h2 } });
        } catch {
          // RPC failure — leave chain state intact. Do NOT remove the key —
          // that resets to (0, ZeroHash) and creates an infinite revert loop.
          console.warn(`[datum-daemon] DISCARD_CAMPAIGN_CLAIMS: RPC failed for chain state resync, preserving existing state`);
        }
      }
      return { ok: true };
    }

    case "DISCARD_REJECTED_CLAIMS": {
      if (_queue) {
        const s2 = (await chrome.storage.local.get("settings")).settings;
        for (const campaignId of msg.campaignIds ?? []) {
          await _queue.discardCampaignClaims(msg.userAddress, campaignId);
          const chainKey = `chainState:${msg.userAddress}:${campaignId}`;
          try {
            const p2 = new JsonRpcProvider(s2?.rpcUrl ?? "https://eth-rpc-testnet.polkadot.io/");
            const stl2 = getSettlementContract(s2?.contractAddresses, p2);
            const [n2, h2] = await Promise.all([
              stl2.lastNonce(msg.userAddress, campaignId),
              stl2.lastClaimHash(msg.userAddress, campaignId),
            ]);
            await chrome.storage.local.set({ [chainKey]: { userAddress: msg.userAddress, campaignId, lastNonce: Number(n2), lastClaimHash: h2 } });
          } catch {
            console.warn(`[datum-daemon] DISCARD_REJECTED_CLAIMS: RPC failed for campaign ${campaignId}, preserving existing chain state`);
          }
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

    // ── Publisher attestation ──────────────────────────────────────────────
    // DatumAttestationVerifier verifies the sig against:
    //   campaigns.getCampaignRelaySigner(id) if set, else the publisher address.
    // _relayWallet is seeded with Diana's key, which is the on-chain relaySigner
    // for all testnet campaigns. Override via SET_RELAY_SIGNER_KEY if needed.
    case "REQUEST_PUBLISHER_ATTESTATION": {
      try {
        const stored = await chrome.storage.local.get("settings");
        const attestationVerifierAddr: string =
          stored.settings?.contractAddresses?.attestationVerifier
          ?? "0x73C002D6cf9dFEdb6257F7c9210e04651BFeA2af"; // fallback: Paseo deployed address
        const sig = await signPublisherAttestation(
          msg.campaignId, msg.userAddress,
          msg.firstNonce, msg.lastNonce, msg.claimCount,
          attestationVerifierAddr,
          loadOrCreateRelayWallet(),
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
        const s2 = await chrome.storage.local.get(["connectedAddress", "activeCampaigns", "claimBuilderMode"]);
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

        const clearingCpm = msg.clearingCpmPlanck
          ? BigInt(msg.clearingCpmPlanck)
          : BigInt(campaign.bidCpmPlanck ?? "0");

        // ── Aggregated mode: queue raw impression, defer hashing to flush time ──
        if ((s2.claimBuilderMode ?? "per-impression") === "aggregated") {
          const rawQs = await chrome.storage.local.get("rawImpressionQueue");
          const rawQueue: any[] = rawQs.rawImpressionQueue ?? [];
          rawQueue.push({
            campaignId: String(msg.campaignId),
            publisher: msg.publisherAddress,
            clearingCpmPlanck: clearingCpm.toString(),
            userAddress,
          });
          await chrome.storage.local.set({ rawImpressionQueue: rawQueue });
          _lastImpressionResult = { ok: true, campaignId: String(msg.campaignId), user: userAddress.slice(0, 10), ts: Date.now() };
          console.log(`[datum-daemon] Raw impression queued (aggregated): campaign=${msg.campaignId} rawDepth=${rawQueue.length}`);
          return { ok: true };
        }

        // ── Per-impression mode: hash immediately and append to claimQueue ──────
        const CHAIN_KEY = `chainState:${userAddress}:${msg.campaignId}`;
        const qs = await chrome.storage.local.get([CHAIN_KEY, "claimQueue"]);
        const chain = qs[CHAIN_KEY] ?? { lastNonce: 0, lastClaimHash: ZeroHash };
        console.log(`[datum-daemon] IMPRESSION_RECORDED: campaign=${msg.campaignId} chainState.lastNonce=${chain.lastNonce} chainState.lastClaimHash=${String(chain.lastClaimHash).slice(0, 12)}…`);

        const campaignIdBig = BigInt(msg.campaignId);
        const nonce = BigInt(chain.lastNonce + 1);
        const prevHash: string = chain.lastNonce === 0 ? ZeroHash : chain.lastClaimHash;

        // Blake2-256 matching Settlement._validateClaim() field order:
        // (campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)
        const packed = solidityPacked(
          ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
          [campaignIdBig, msg.publisherAddress, userAddress, 1n, clearingCpm, nonce, prevHash]
        );
        const packedBytes = getBytes(packed);
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
        console.log(`[datum-daemon] Claim queued: campaign=${msg.campaignId} nonce=${nonce} prevHash=${prevHash.slice(0, 12)}… claimHash=${claimHash.slice(0, 12)}… user=${userAddress.slice(0, 8)}…`);
        return { ok: true };
      } catch (err) {
        _lastImpressionResult = { ok: false, reason: String(err), ts: Date.now() };
        console.error("[datum-daemon] IMPRESSION_RECORDED error:", err);
        return { ok: false, reason: String(err) };
      }
    }

    case "SET_CLAIM_BUILDER_MODE": {
      const mode: "per-impression" | "aggregated" = msg.mode === "aggregated" ? "aggregated" : "per-impression";
      await chrome.storage.local.set({ claimBuilderMode: mode });
      console.log(`[datum-daemon] Claim builder mode set to: ${mode}`);
      return { ok: true, mode };
    }

    case "UPDATE_INTEREST": {
      if (_interest) await _interest.updateProfile(msg.tags ?? []);
      return { ok: true };
    }

    case "SET_PUBLISHER_RELAY": {
      // Store publisher→relay domain mapping so ClaimQueue relay submission can find it.
      const pub: string = msg.publisher ?? "";
      const relayRaw: string = msg.relay ?? "";
      if (pub && relayRaw && /^0x[0-9a-fA-F]{40}$/.test(pub)) {
        const domain = relayRaw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const key = `publisherDomain:${pub.toLowerCase()}`;
        await chrome.storage.local.set({ [key]: domain });
        console.log(`[datum-daemon] Publisher relay set: ${pub.slice(0, 10)}… → ${domain}`);
      }
      return { ok: true };
    }

    case "GET_RELAY_SIGNER":
      return { address: getRelaySignerAddress() };

    case "SET_RELAY_SIGNER_KEY": {
      const ok = importRelaySignerKey(msg.privateKey ?? "");
      return { ok, address: ok ? getRelaySignerAddress() : undefined };
    }

    case "REPORT_PAGE":
    case "REPORT_AD":
      return { ok: true };

    case "SYNC_CHAIN_STATE": {
      // Update local chain state to on-chain values and clear queued claims whose
      // prevHash chain is now invalid (they were built from a stale/wrong base).
      const chainKey = `chainState:${msg.userAddress}:${msg.campaignId}`;
      await chrome.storage.local.set({
        [chainKey]: {
          userAddress: msg.userAddress,
          campaignId: msg.campaignId,
          lastNonce: msg.onChainNonce,
          lastClaimHash: msg.onChainHash,
        },
      });
      if (_queue) await _queue.discardCampaignClaims(msg.userAddress, msg.campaignId);
      return { ok: true };
    }

    case "RESET_CHAIN_STATE":
      return { ok: true };

    case "SIGN_FOR_RELAY":
      return { ok: false, reason: "auto-submit not available in demo" };

    case "DAEMON_SUBMIT_CLAIMS": {
      try {
        if (!_queue) return { ok: false, error: "Queue not initialized" };
        const s = (await chrome.storage.local.get("settings")).settings;
        if (!s?.contractAddresses?.attestationVerifier)
          return { ok: false, error: "AttestationVerifier not configured" };
        const userAddress: string = msg.userAddress ?? "";
        if (!userAddress) return { ok: false, error: "No user address provided" };

        // ── Aggregated mode: drain rawImpressionQueue → build aggregated claims ──
        // Each group of (campaignId, clearingCpmPlanck) impressions is collapsed into
        // claims of up to MAX_IMPRESSIONS_PER_CLAIM each using impressionCount > 1.
        // This yields ~250× more throughput: 4 claims × 250 impressions = 1000 impressions/tx.
        {
          const MAX_IMPRESSIONS_PER_CLAIM = 250;
          const stored2 = await chrome.storage.local.get(["claimBuilderMode", "rawImpressionQueue"]);
          const rawQueue: any[] = stored2.rawImpressionQueue ?? [];
          if ((stored2.claimBuilderMode ?? "per-impression") === "aggregated" && rawQueue.length > 0) {
            // Group by (campaignId, clearingCpmPlanck) — all entries share the same userAddress
            // since claimQueue is per-user. Group key uses campaignId+cpm only; publisher is
            // taken from the first entry in each group (immutable per campaign).
            const groups = new Map<string, any[]>();
            for (const raw of rawQueue) {
              const key = `${raw.campaignId}:${raw.clearingCpmPlanck}`;
              const g = groups.get(key) ?? [];
              g.push(raw);
              groups.set(key, g);
            }

            const qs2 = await chrome.storage.local.get("claimQueue");
            const existingQueue: any[] = qs2.claimQueue ?? [];

            for (const [, impressions] of groups) {
              const { campaignId: cid, publisher, clearingCpmPlanck: cpm, userAddress: ua } = impressions[0];
              const chainKey = `chainState:${ua}:${cid}`;
              const chainStored = await chrome.storage.local.get(chainKey);
              let chain = chainStored[chainKey] ?? { lastNonce: 0, lastClaimHash: ZeroHash };

              for (let i = 0; i < impressions.length; i += MAX_IMPRESSIONS_PER_CLAIM) {
                const chunk = impressions.slice(i, i + MAX_IMPRESSIONS_PER_CLAIM);
                const impressionCount = BigInt(chunk.length);
                const nonce = BigInt(chain.lastNonce + 1);
                const prevHash: string = chain.lastNonce === 0 ? ZeroHash : chain.lastClaimHash;
                const campaignIdBig = BigInt(cid);
                const clearingCpm = BigInt(cpm);

                const packed = solidityPacked(
                  ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
                  [campaignIdBig, publisher, ua, impressionCount, clearingCpm, nonce, prevHash]
                );
                const hashBytes = blake2b(getBytes(packed), { dkLen: 32 });
                const claimHash = "0x" + Array.from(hashBytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");

                existingQueue.push({
                  campaignId: cid,
                  publisher,
                  impressionCount: impressionCount.toString(),
                  clearingCpmPlanck: cpm,
                  nonce: nonce.toString(),
                  previousClaimHash: prevHash,
                  claimHash,
                  zkProof: "0x",
                  userAddress: ua,
                });

                chain = { lastNonce: Number(nonce), lastClaimHash: claimHash };
              }

              await chrome.storage.local.set({
                [chainKey]: { userAddress: ua, campaignId: cid, lastNonce: chain.lastNonce, lastClaimHash: chain.lastClaimHash },
              });
            }

            await chrome.storage.local.set({ claimQueue: existingQueue, rawImpressionQueue: [] });
            console.log(`[datum-daemon] Aggregated ${rawQueue.length} raw impressions → ${existingQueue.length} queued claims`);
          }
        }

        const batches = await _queue.buildBatches(userAddress);
        if (batches.length === 0) return { ok: false, error: "No pending claims" };

        const relayWallet = loadOrCreateRelayWallet();
        const provider = new JsonRpcProvider(s.rpcUrl ?? "https://eth-rpc-testnet.polkadot.io/");
        const signer = relayWallet.connect(provider);
        // Use Settlement.settleClaims — allows publisher relaySigner (Diana) as msg.sender.
        // DatumAttestationVerifier.settleClaimsAttested requires msg.sender == user (E32).
        const settlement = getSettlementContract(s.contractAddresses, signer);
        console.log(`[datum-daemon] relay wallet address: ${relayWallet.address}`);

        // Split each batch at 4 claims — pallet-revive eth_call hard limit (~5 external calls/claim,
        // 5 claims always reverts with data=null regardless of gasLimit; 4 is confirmed safe on Paseo)
        const MAX_CLAIMS_PER_BATCH = 4;
        const splitBatches: typeof batches = [];
        for (const b of batches) {
          if (b.claims.length <= MAX_CLAIMS_PER_BATCH) {
            splitBatches.push(b);
          } else {
            for (let j = 0; j < b.claims.length; j += MAX_CLAIMS_PER_BATCH) {
              splitBatches.push({ ...b, claims: b.claims.slice(j, j + MAX_CLAIMS_PER_BATCH) });
            }
          }
        }

        // One campaign per tx — pallet-revive limit is ~4 total claims across all batches per call.
        // 3 campaigns × 4 claims = 12 total always reverts. Confirmed safe: 1 batch × ≤4 claims.
        const CHUNK_SIZE = 1;
        const txChunks: (typeof splitBatches)[] = [];
        let cur: typeof splitBatches = [];
        const seen = new Set<string>();
        for (const b of splitBatches) {
          const cid = b.campaignId.toString();
          if (cur.length >= CHUNK_SIZE || seen.has(cid)) {
            txChunks.push(cur); cur = []; seen.clear();
          }
          cur.push(b); seen.add(cid);
        }
        if (cur.length > 0) txChunks.push(cur);

        let totalSettled = 0;
        const settledNonces = new Map<string, bigint[]>();
        let lastTxError: string | null = null;

        // Pre-submit: validate each batch's first claim nonce against on-chain lastNonce.
        // If stale/mismatched, discard claims and reset local chain state before submitting.
        const validSplitBatches: typeof splitBatches = [];
        for (const b of splitBatches) {
          const cid = b.campaignId.toString();
          try {
            const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId);
            const expectedFirst = onChainNonce + 1n;
            const actualFirst: bigint = b.claims[0].nonce;
            const allNonces = b.claims.map((c: any) => c.nonce.toString()).join(",");
            console.log(`[datum-daemon] Pre-submit campaign ${cid}: on-chain=${onChainNonce}, local nonces=[${allNonces}], expected first=${expectedFirst}`);
            // Also fetch on-chain lastClaimHash to verify the hash chain is intact
            const onChainHash: string = onChainNonce > 0n
              ? await settlement.lastClaimHash(b.user, b.campaignId)
              : "0x0000000000000000000000000000000000000000000000000000000000000000";
            const localPrevHash: string = b.claims[0].previousClaimHash;

            if (actualFirst !== expectedFirst) {
              console.warn(
                `[datum-daemon] Nonce mismatch for campaign ${cid}: local first=${actualFirst}, expected=${expectedFirst} (on-chain=${onChainNonce}). Discarding stale claims.`
              );
              await _queue.discardCampaignClaims(userAddress, cid);
              const chainKey = `chainState:${userAddress}:${cid}`;
              await chrome.storage.local.set({ [chainKey]: { userAddress, campaignId: cid, lastNonce: Number(onChainNonce), lastClaimHash: onChainHash } });
              continue;
            }

            // Nonce matches — verify previousClaimHash matches on-chain lastClaimHash.
            // If they differ, the claim was built from a stale/wrong chain base and will revert.
            if (String(localPrevHash).toLowerCase() !== String(onChainHash).toLowerCase()) {
              console.warn(
                `[datum-daemon] Hash mismatch for campaign ${cid}: claim prevHash=${localPrevHash.slice(0, 14)}… on-chain=${String(onChainHash).slice(0, 14)}…. Discarding stale claims.`
              );
              await _queue.discardCampaignClaims(userAddress, cid);
              const chainKey = `chainState:${userAddress}:${cid}`;
              await chrome.storage.local.set({ [chainKey]: { userAddress, campaignId: cid, lastNonce: Number(onChainNonce), lastClaimHash: onChainHash } });
              continue;
            }
          } catch (e) {
            console.warn(`[datum-daemon] lastNonce check failed for campaign ${cid}:`, e);
            // Don't skip on RPC error — attempt submission anyway
          }
          validSplitBatches.push(b);
        }

        if (validSplitBatches.length === 0) {
          return { ok: false, error: "All claims had stale nonces or invalid hash chains — queue cleared. Browse pages to accumulate fresh claims." };
        }

        // Pre-submit: dry-run validateClaim on-chain for first claim of each batch.
        // This catches all rejection reasons (publisher mismatch, campaign inactive,
        // CPM too high, hash mismatch, ZK proof required, etc.) BEFORE sending a tx.
        const REJECTION_REASONS: Record<number, string> = {
          0: "campaign paused", 1: "inactivity timeout", 2: "zero impressions",
          3: "campaign bidCpm is 0", 4: "campaign not active", 5: "publisher mismatch",
          6: "clearingCpm exceeds bidCpm", 7: "nonce chain invalid", 8: "first claim prevHash not zero",
          9: "previousClaimHash mismatch", 10: "claimHash mismatch (hash function divergence)",
          11: "publisher blocklisted", 13: "user impression cap exceeded",
          14: "publisher rate limit exceeded", 15: "open campaign + allowlisted publisher",
          16: "ZK proof required but missing", 17: "impressionCount out of range", 18: "budget exhausted",
        };
        if (s.contractAddresses?.claimValidator) {
          const claimValidator = getClaimValidatorContract(s.contractAddresses, provider);
          const toRemove: Set<number> = new Set();
          for (let i = 0; i < validSplitBatches.length; i++) {
            const b = validSplitBatches[i];
            const cid = b.campaignId.toString();
            try {
              const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId);
              const expectedNonce = onChainNonce + 1n;
              const expectedPrevHash: string = onChainNonce > 0n
                ? await settlement.lastClaimHash(b.user, b.campaignId)
                : "0x0000000000000000000000000000000000000000000000000000000000000000";
              const firstClaim = b.claims[0];
              const claimStruct = {
                campaignId: firstClaim.campaignId,
                publisher: firstClaim.publisher,
                impressionCount: firstClaim.impressionCount,
                clearingCpmPlanck: firstClaim.clearingCpmPlanck,
                nonce: firstClaim.nonce,
                previousClaimHash: firstClaim.previousClaimHash,
                claimHash: firstClaim.claimHash,
                zkProof: firstClaim.zkProof,
              };
              const [ok, reasonCode]: [boolean, number] = await claimValidator.validateClaim(
                claimStruct, b.user, expectedNonce, expectedPrevHash,
              );
              console.log(`[datum-daemon] Pre-submit validateClaim campaign ${cid}: ok=${ok} code=${reasonCode}`);
              if (!ok) {
                const reason = REJECTION_REASONS[reasonCode] ?? `unknown (code ${reasonCode})`;
                console.warn(`[datum-daemon] Pre-submit validateClaim REJECTED campaign ${cid}: reason=${reasonCode} (${reason})`);
                await _queue.discardCampaignClaims(userAddress, cid);
                const chainKey = `chainState:${userAddress}:${cid}`;
                await chrome.storage.local.set({ [chainKey]: { userAddress, campaignId: cid, lastNonce: Number(onChainNonce), lastClaimHash: expectedPrevHash } });
                toRemove.add(i);
                lastTxError = `Campaign ${cid} rejected: ${reason}`;
              }
            } catch (e) {
              console.warn(`[datum-daemon] validateClaim dry-run failed for campaign ${cid}:`, e);
              // RPC error — don't skip, let tx attempt proceed
            }
          }
          if (toRemove.size > 0) {
            const filtered = validSplitBatches.filter((_, i) => !toRemove.has(i));
            validSplitBatches.length = 0;
            validSplitBatches.push(...filtered);
          }
          if (validSplitBatches.length === 0) {
            return { ok: false, error: lastTxError ?? "All claims rejected by on-chain validation — queue cleared." };
          }
        }

        // Re-chunk with valid batches only
        const validTxChunks: (typeof validSplitBatches)[] = [];
        {
          let cur2: typeof validSplitBatches = [];
          const seen2 = new Set<string>();
          for (const b of validSplitBatches) {
            const cid = b.campaignId.toString();
            if (cur2.length >= CHUNK_SIZE || seen2.has(cid)) {
              validTxChunks.push(cur2); cur2 = []; seen2.clear();
            }
            cur2.push(b); seen2.add(cid);
          }
          if (cur2.length > 0) validTxChunks.push(cur2);
        }

        for (const chunk of validTxChunks) {
          // ClaimBatch for settleClaims: {user, campaignId, claims} — no publisherSig needed.
          // Diana is authorized via isPublisherRelay (publishers.relaySigner(publisher) == Diana).
          const claimBatches = chunk.map((b: any) => ({
            user: b.user,
            campaignId: b.campaignId,
            claims: b.claims,
          }));

          // Record expected post-settlement nonces for on-chain verification
          const expectedNonces = new Map<string, bigint>();
          for (const b of chunk) {
            expectedNonces.set(b.campaignId.toString(), b.claims[b.claims.length - 1].nonce);
          }

          const nonceBefore = await provider.getTransactionCount(relayWallet.address);
          console.log(`[datum-daemon] submitting settleClaims: relayWallet=${relayWallet.address} nonceBefore=${nonceBefore} batches=${claimBatches.length} campaigns=${claimBatches.map((b: any) => b.campaignId.toString()).join(",")}`);

          // Try staticCall first to surface revert reason (best-effort — Paseo may still revert live)
          try {
            await settlement.settleClaims.staticCall(claimBatches, { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n });
            console.log("[datum-daemon] settleClaims staticCall: PASSED");
          } catch (staticErr: any) {
            const staticMsg = staticErr?.message ?? String(staticErr);
            console.warn(`[datum-daemon] settleClaims staticCall: REVERTED — ${staticMsg.slice(0, 200)}`);
          }

          try {
            await settlement.settleClaims(claimBatches, { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n });
          } catch (txErr) {
            lastTxError = String(txErr);
            console.warn("[datum-daemon] settleClaims tx error:", txErr);
            continue;
          }
          // Nonce polling — Paseo getTransactionReceipt returns null for confirmed txs
          for (let i = 0; i < 60; i++) {
            const current = await provider.getTransactionCount(relayWallet.address);
            if (current > nonceBefore) break;
            await new Promise((r) => setTimeout(r, 2000));
          }

          // Paseo eth-rpc: state reads may lag behind tx inclusion — wait for state to propagate
          await new Promise((r) => setTimeout(r, 3000));

          // Post-submit: verify on-chain lastNonce actually advanced for at least one batch
          let anySettled = false;
          for (const b of chunk) {
            const cid = b.campaignId.toString();
            try {
              // Retry lastNonce check — Paseo state reads can be stale immediately after tx
              let onChainNonce: bigint = 0n;
              for (let attempt = 0; attempt < 3; attempt++) {
                onChainNonce = await settlement.lastNonce(b.user, b.campaignId);
                if (onChainNonce >= b.claims[0].nonce) break;
                if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
              }
              if (onChainNonce >= b.claims[0].nonce) {
                // At least partially settled — count the claims up to on-chain nonce
                const firstNonce: bigint = b.claims[0].nonce;
                const settledCount = Number(onChainNonce - firstNonce + 1n);
                const nonces = settledNonces.get(cid) ?? [];
                for (let i = 0; i < Math.min(settledCount, b.claims.length); i++) {
                  nonces.push(b.claims[i].nonce);
                }
                settledNonces.set(cid, nonces);
                totalSettled += Math.min(settledCount, b.claims.length);
                anySettled = true;
                // Sync chain state from on-chain so new impressions start from verified base
                try {
                  const onChainHash: string = await settlement.lastClaimHash(b.user, b.campaignId);
                  const chainKey = `chainState:${userAddress}:${cid}`;
                  await chrome.storage.local.set({ [chainKey]: { userAddress, campaignId: cid, lastNonce: Number(onChainNonce), lastClaimHash: String(onChainHash) } });
                  console.log(`[datum-daemon] Synced chain state for campaign ${cid}: nonce=${onChainNonce} hash=${String(onChainHash).slice(0, 14)}…`);
                } catch {
                  console.warn(`[datum-daemon] Could not sync chain state after settlement for campaign ${cid}`);
                }
                console.log(`[datum-daemon] Verified ${Math.min(settledCount, b.claims.length)} claims settled for campaign ${cid}, on-chain nonce=${onChainNonce}`);
              } else {
                // Tx reverted — discard claims and reset chain state for this campaign
                console.warn(`[datum-daemon] Settlement reverted for campaign ${cid}: on-chain nonce=${onChainNonce}, expected=${expectedNonces.get(cid)}. Discarding claims.`);
                await _queue.discardCampaignClaims(userAddress, cid);
                // Seed chain state from on-chain so next impression starts at the right nonce
                const chainKey = `chainState:${userAddress}:${cid}`;
                try {
                  const onChainHash: string = await settlement.lastClaimHash(b.user, b.campaignId);
                  await chrome.storage.local.set({ [chainKey]: { userAddress, campaignId: cid, lastNonce: Number(onChainNonce), lastClaimHash: onChainHash } });
                } catch {
                  // RPC failure — leave chain state intact; pruneSettledClaims will resync on next cycle.
                  // Do NOT remove the key — that resets to (0, ZeroHash) and creates an infinite revert loop.
                  console.warn(`[datum-daemon] Could not fetch on-chain hash for campaign ${cid} after revert — chain state preserved`);
                }
                // Try to diagnose the actual rejection reason via ClaimValidator
                let rejectReason = "nonce chain invalid or budget exhausted";
                if (s.contractAddresses?.claimValidator) {
                  try {
                    const cv = getClaimValidatorContract(s.contractAddresses, provider);
                    const expectedNonce2 = onChainNonce + 1n;
                    const expectedPrevHash2: string = onChainNonce > 0n
                      ? await settlement.lastClaimHash(b.user, b.campaignId)
                      : "0x0000000000000000000000000000000000000000000000000000000000000000";
                    const fc = b.claims[0];
                    const [vOk, vCode]: [boolean, number] = await cv.validateClaim(
                      { campaignId: fc.campaignId, publisher: fc.publisher, impressionCount: fc.impressionCount, clearingCpmPlanck: fc.clearingCpmPlanck, nonce: fc.nonce, previousClaimHash: fc.previousClaimHash, claimHash: fc.claimHash, zkProof: fc.zkProof },
                      b.user, expectedNonce2, expectedPrevHash2,
                    );
                    if (!vOk) rejectReason = REJECTION_REASONS[vCode] ?? `code ${vCode}`;
                  } catch { /* RPC failed — use generic message */ }
                }
                lastTxError = `Settlement reverted for campaign ${cid}: ${rejectReason}`;
              }
            } catch (e) {
              // RPC error — leave claims in queue for retry; pruneSettledClaims will clean up when RPC recovers
              console.warn(`[datum-daemon] Post-submit lastNonce RPC failed for campaign ${cid} — claims kept in queue for retry:`, e);
            }
          }
          if (!anySettled && !lastTxError) lastTxError = "Settlement tx reverted (no claims confirmed on-chain)";
        }

        if (totalSettled === 0 && lastTxError) {
          console.error("[datum-daemon] All tx chunks failed. Last error:", lastTxError);
          return { ok: false, error: lastTxError };
        }
        if (totalSettled > 0) await _queue.removeSettled(userAddress, settledNonces);
        console.log(`[datum-daemon] DAEMON_SUBMIT_CLAIMS: settleClaims settled ${totalSettled} claims for ${userAddress.slice(0, 10)}…`);
        return { ok: true, settledCount: totalSettled };
      } catch (err) {
        console.error("[datum-daemon] DAEMON_SUBMIT_CLAIMS error:", err);
        return { ok: false, error: String(err) };
      }
    }

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

  // Seed Diana's publisher relay domain so ClaimQueue relay submission works
  // automatically without manual configuration. RELAY_URL minus protocol/trailing slash.
  // Hardcode Diana's address — do NOT derive from loadOrCreateRelayWallet() which
  // could return a stale key if localStorage held a previous value.
  const DIANA_PUBLISHER_ADDR = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
  const RELAY_DOMAIN = "relay.javcon.io";
  const pubDomainKey = `publisherDomain:${DIANA_PUBLISHER_ADDR.toLowerCase()}`;
  // Always overwrite so stale domain entries don't survive re-deploys.
  await chrome.storage.local.set({ [pubDomainKey]: RELAY_DOMAIN });
  console.log(`[datum-daemon] seeded publisher relay: ${DIANA_PUBLISHER_ADDR.slice(0, 10)}… → ${RELAY_DOMAIN}`);

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
          // New contract deployment — purge stale chain state and claim queue so old nonces
          // don't cause soft-rejects on the new contract (where on-chain nonces are all 0).
          if (cachedAddr && cachedAddr.toLowerCase() !== s.contractAddresses.campaigns.toLowerCase()) {
            const all = await chrome.storage.local.get(null);
            const staleKeys = Object.keys(all).filter((k) => k.startsWith("chainState:"));
            if (staleKeys.length > 0) {
              await chrome.storage.local.remove(staleKeys);
              console.log(`[datum-daemon] cleared ${staleKeys.length} stale chainState entries after deployment change`);
            }
            if (_queue) await _queue.clear();
            console.log("[datum-daemon] cleared claim queue after deployment change");
          }
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
