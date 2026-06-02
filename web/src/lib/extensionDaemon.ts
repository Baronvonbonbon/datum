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

// MUST be first: installs the chrome.* shim before the statically-imported
// background-router graph evaluates (some of those modules touch chrome.* at
// import time — e.g. pineBridge's onMessage listener). See installShim.ts.
import "./installShim";

import { Wallet, JsonRpcProvider, ZeroHash, keccak256 as ethersKeccak256, solidityPacked, toBeHex } from "ethers";

// #5 PoW: grind a powNonce so keccak256(abi.encodePacked(claimHash, nonce)) <= target,
// exactly matching DatumClaimValidator's PoW check. The alpha-5 PowEngine enforces PoW
// at trivial (~1-byte) difficulty, so this resolves in a few hundred iterations.
function solvePowNonce(claimHash: string, target: bigint, maxIters = 2_000_000): string | null {
  for (let i = 0; i < maxIters; i++) {
    const nonceHex = toBeHex(i, 32);
    if (BigInt(ethersKeccak256(solidityPacked(["bytes32", "bytes32"], [claimHash, nonceHex]))) <= target) return nonceHex;
  }
  return null;
}
// Canonical claim hash lives in claimCore (shared with the extension claimBuilder)
// — the daemon must NOT keep its own copy of the preimage schema (it drifted 3×).
import { computeClaimHash } from "@ext/background/claimCore";
// The ONE shared message router + the real claimBuilder. Workstream A: the demo
// no longer hand-mirrors the background switch — it builds demoEnv and calls the
// same routeMessage. Workstream B: claimBuilder is now snarkjs-free (ZK injected
// via setProveZk, left null here), so the demo imports the canonical builder.
import { routeMessage, EnvContext } from "@ext/background/router";
import { claimBuilder } from "@ext/background/claimBuilder";

// Claim-submission status published to chrome.storage.local so the popup's
// PollStatusBar can commandeer its slot to show submitting / settled / failed
// (with the submit path + campaigns) while a settlement is in flight.
const CLAIM_STATUS_KEY = "claimStatus";
async function writeClaimStatus(s: Record<string, unknown> | null): Promise<void> {
  try {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.storage?.local) return;
    if (s === null) await c.storage.local.remove(CLAIM_STATUS_KEY);
    else await c.storage.local.set({ [CLAIM_STATUS_KEY]: { ...s, updatedAt: Date.now() } });
  } catch { /* non-fatal */ }
}

import { pineRpc, getPineProvider, getPineStatus } from "./provider";
import { getSettlementContract, getClaimValidatorContract, getCampaignsContract, getPowEngineContract, getBudgetLedgerContract, getPublisherReputationContract } from "@shared/contracts";

// Probe the settlement-level gates the daemon can read, used when a settleClaims
// tx reverts with NO reason data (bare require) and validateClaim itself passes —
// converts an opaque revert into a named cause shown in the claim-status indicator.
// Best-effort: every read is guarded so a missing getter just skips that check.
async function probeSettlementRevert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contractAddresses: any,
  provider: JsonRpcProvider,
  campaignId: bigint,
  claim: { publisher: string; ratePlanck: bigint; actionType: number; eventCount: bigint },
  relayAddr: string,
): Promise<string | null> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
  try {
    const campaigns = getCampaignsContract(contractAddresses, provider);

    // 1. Campaign must be Active (settlement rejects any other status).
    try {
      const r = await campaigns.getCampaignForSettlement(campaignId);
      const st = Number(r[0] ?? r.status);
      const pub: string = r[1] ?? r.publisher;
      if (st !== 1) return `campaign #${campaignId} is ${STATUS[st] ?? `status ${st}`}, not Active`;
      if (pub && pub !== ZERO && pub.toLowerCase() !== claim.publisher.toLowerCase())
        return `publisher mismatch — campaign #${campaignId} is fixed to ${pub.slice(0, 10)}…, claim served on ${claim.publisher.slice(0, 10)}…`;
    } catch { /* getter unavailable — skip */ }

    // 2. AssuranceLevel ≥ 2 ⇒ dual-sig required; the gasless relay path is rejected.
    try {
      const lvl = Number(await campaigns.getCampaignAssuranceLevel(campaignId));
      if (lvl >= 2) return `campaign #${campaignId} requires AssuranceLevel L${lvl} (dual-sig) — gasless relay settleClaims not allowed; needs publisher+advertiser cosign`;
    } catch { /* skip */ }

    // 3. Relay wallet must be the campaign's authorized relaySigner.
    try {
      const rs: string = await campaigns.getCampaignRelaySigner(campaignId);
      if (rs && rs !== ZERO && rs.toLowerCase() !== relayAddr.toLowerCase())
        return `relay ${relayAddr.slice(0, 10)}… is not campaign #${campaignId}'s relaySigner (${rs.slice(0, 10)}…) — settleClaims sender unauthorized`;
    } catch { /* skip */ }

    // 4. CPM pot must exist + its rate ceiling must cover the claim rate.
    try {
      const pot = await campaigns.getCampaignPot(campaignId, claim.actionType);
      const potRate = BigInt(pot.ratePlanck ?? pot[3] ?? 0);
      const budget = BigInt(pot.budgetPlanck ?? pot[1] ?? 0);
      if (budget === 0n) return `campaign #${campaignId} actionType-${claim.actionType} pot has zero budget`;
      if (potRate > 0n && claim.ratePlanck > potRate) return `claim rate ${claim.ratePlanck} exceeds pot ceiling ${potRate} (campaign #${campaignId})`;
    } catch {
      return `campaign #${campaignId} has no pot for actionType ${claim.actionType} (getCampaignPot reverted)`;
    }
  } catch { /* campaigns contract unavailable */ }

  // 5–7: settlement-execution gates (LogicB processBatch), which the campaign-level
  // checks above don't cover — budget ledger, reputation, and Paseo's denomination
  // rule on the deductAndTransfer payout.
  const ev = claim.eventCount > 0n ? claim.eventCount : 1n;
  const totalPayment = claim.actionType === 0 ? (claim.ratePlanck * ev) / 1000n : claim.ratePlanck * ev;
  try {
    const bl = getBudgetLedgerContract(contractAddresses, provider);
    if (bl) {
      const remaining = BigInt((await bl.getRemainingBudget(campaignId, claim.actionType)).toString());
      if (remaining < totalPayment) return `budget ledger remaining ${remaining} < payout ${totalPayment} (campaign #${campaignId})`;
    }
  } catch { /* getter unavailable — skip */ }
  try {
    const rep = getPublisherReputationContract(contractAddresses, provider);
    if (rep && !(await rep.canSettle(claim.publisher))) return `reputation gate blocks publisher ${claim.publisher.slice(0, 10)}…`;
  } catch { /* skip */ }
  // Paseo native transfers revert (no data) when value % 1e6 ≥ 500_000. deductAndTransfer
  // moves exactly `totalPayment` planck to the paymentVault.
  if (totalPayment % 1_000_000n >= 500_000n)
    return `payout ${totalPayment} planck violates Paseo rounding (% 1e6 = ${totalPayment % 1_000_000n} ≥ 500000) — deductAndTransfer reverts; CPM ${claim.ratePlanck} needs rounding`;
  return null;
}

// (the chrome.* shim is installed by the first import — see installShim.ts.)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

// ── Lazy module references (populated by startDaemon) ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _poller: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _queue: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _interest: any = null;
// Wallet RPC dispatcher + offscreen wallet handler. The popup talks to the
// background via WALLET_RPC_REQUEST → dispatcher → walletRpc → offscreen
// wallet. In the demo there is no offscreen document, but the modules are
// pure (storage + SubtleCrypto), so we run both layers in-page.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _walletDispatcher: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _walletOffscreen: any = null;

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

/** Read the current interest profile from storage — used by the browse simulator. */
export async function getInterestProfile(): Promise<{ weights: Record<string, number>; visitCounts: Record<string, number> }> {
  if (_interest) {
    const p = await _interest.getProfile();
    return { weights: p.weights ?? {}, visitCounts: p.visitCounts ?? {} };
  }
  // Fallback: read storage directly (daemon not yet started)
  const stored = await chrome.storage.local.get("interestProfile");
  const p = stored.interestProfile ?? {};
  return { weights: p.weights ?? {}, visitCounts: p.visitCounts ?? {} };
}

/** Update the interest profile with a list of tag strings (simulated page visit). */
export async function updateInterestProfile(tags: string[]): Promise<void> {
  if (_interest) await _interest.updateProfile(tags);
}

/** Return the number of campaigns currently in the local cache. */
export async function getCampaignCount(): Promise<number> {
  if (!_poller) return 0;
  const cached = await _poller.getCachedSerialized();
  return cached.length;
}

/** Return all cached campaigns with status 0 (Pending) or 1 (Active). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getActiveCampaigns(): Promise<Array<Record<string, any>>> {
  if (!_poller) return [];
  const cached = await _poller.getCachedSerialized();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return cached.filter((c: any) => Number(c.status) <= 1);
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

// Claim-batch serialization (SUBMIT_CLAIMS etc.) is now handled by the shared
// router's serializeBatches — the daemon no longer keeps its own copy.

// ── demoEnv: the seam the shared router reaches env-specific capability through.
// Everything the demo does differently from the service worker lives here:
// page-pine reads instead of an offscreen smoldot, no live earnings indexer, no
// chrome.alarms, no auto-submit session, no EIP-1193 signing (the demo injects
// no page provider so those never arrive). The genuinely-identical handlers in
// routeMessage use the same singletons (claimQueue, poller, prefs, interest,
// contracts) the daemon already imports.

const demoEnv: EnvContext = {
  // Contract reads run over the configured RPC. (Pine reads go through
  // pineProvider below; the page provider's PROVIDER_RPC_PROXY uses that.)
  async readProvider(settings) {
    return new JsonRpcProvider(settings.rpcUrl ?? "https://eth-rpc-testnet.polkadot.io/");
  },
  // The demo has no offscreen smoldot — route pine reads to the page's own
  // pine instance (the same path the popup's Pine reads use).
  async pineProvider() {
    return { send: (method: string, params: unknown[]) => pineRpc(method, params) };
  },
  // No History-tab earnings indexer in the demo (the Earnings tab reads balances
  // via wallet RPC directly).
  earnings: { start: async () => {}, stop: async () => {} },
  // No chrome.alarms to re-arm; SETTINGS_UPDATED is handled by the pre-router
  // (which persists msg.settings), so this is a no-op.
  onSettingsUpdated: async () => {},
  // Auto-submit (background session key) is disabled in the demo.
  autoSubmit: { authorize: async () => {}, revoke: async () => {}, isAuthorized: async () => false },
  // EIP-1193 signing never reaches the demo (no injected page provider) — stubs.
  signing: {
    signTypedData: async () => ({ error: "signing is not available in the demo" }),
    personalSign: async () => ({ error: "signing is not available in the demo" }),
    sendTransaction: async () => ({ error: "signing is not available in the demo" }),
    resolveApproval: async () => ({ ok: false, error: "no pending approval in the demo" }),
  },
  async walletProvider(msg) {
    return { type: "WALLET_PROVIDER_RESPONSE", requestId: msg.requestId, ok: false, error: { code: 4100, message: "no injected page provider in the demo" } };
  },
  // Publisher attestation is handled by the demo pre-router (Diana local key);
  // routeMessage's REQUEST_PUBLISHER_ATTESTATION never runs here, so this stub
  // is unreachable but kept to satisfy the interface.
  async requestAttestation() {
    return { error: "attestation handled by the demo pre-router" };
  },
};

// routeMessage requires a chrome.runtime.MessageSender; the demo has no real
// sender. The routed handlers that read `sender` (SET_PUBLISHER_RELAY's tab-domain
// guard, the SW-only signing arms) treat an absent sender.tab as "skip the check",
// which is correct for the in-page demo.
const DEMO_SENDER = {} as Parameters<typeof routeMessage>[1];

// ── Message handler ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMessage(msg: any): Promise<unknown> {
  switch (msg.type) {
    // ── Pine (offscreen light-client RPC) ────────────────────────────────────
    // The popup's pineBridge does an "offscreen" round-trip for Pine reads
    // (AssuranceLevel, recovery, the Pine data-path). The real extension runs
    // smoldot in an offscreen document; the demo has none — route these to the
    // page's own Pine provider so the reads resolve instead of erroring with
    // "missing or malformed reply".
    case "PINE_INIT": {
      try {
        await getPineProvider();
      } catch {
        /* connection errors surface through the status object below */
      }
      return { type: "PINE_STATUS", status: getPineStatus() };
    }
    case "PINE_RPC_REQUEST": {
      try {
        const result = await pineRpc(msg.method, msg.params ?? []);
        return { type: "PINE_RPC_RESULT", requestId: msg.requestId, result };
      } catch (err: any) {
        const code = typeof err?.code === "number" ? err.code : -32603;
        const message = typeof err?.message === "string" ? err.message : String(err);
        return { type: "PINE_RPC_RESULT", requestId: msg.requestId, error: { code, message, data: err?.data } };
      }
    }

    // ── Campaigns ──────────────────────────────────────────────────────────
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
    case "SETTINGS_UPDATED": {
      if (msg.settings) await chrome.storage.local.set({ settings: msg.settings });
      return { ok: true };
    }

    // ── Misc ───────────────────────────────────────────────────────────────
    case "CHECK_PUBLISHER_ALLOWLIST":
      // In demo context: no on-chain allowlist check — conservative allow
      return { allowlistEnabled: false };

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

        // ── Per-impression mode: delegate to the real claimBuilder. It's now
        // snarkjs-free (ZK proving is injected via setProveZk — null in the
        // demo), so the daemon imports the canonical claim-builder instead of
        // re-inlining the claim-hash preimage, which drifted from the contract
        // three times. clearingCpm is passed explicitly so claimBuilder doesn't
        // fall back to the campaign's viewBid field (the demo cache uses
        // bidCpmPlanck).
        const impressionNonce = await claimBuilder.onImpression({
          campaignId: String(msg.campaignId),
          url: msg.url ?? "",
          category: msg.category ?? "",
          publisherAddress: msg.publisherAddress,
          clearingCpmPlanck: clearingCpm.toString(),
        });
        if (impressionNonce) {
          _lastImpressionResult = { ok: true, campaignId: String(msg.campaignId), user: userAddress.slice(0, 10), ts: Date.now() };
          return { ok: true, impressionNonce };
        }
        // claimBuilder returned null — publisher mismatch / cache miss / no wallet
        // (it logs the specific reason). Surface a generic drop to the panel.
        _lastImpressionResult = { ok: false, reason: "claim_dropped (see console)", ts: Date.now() };
        return { ok: false, reason: "claim_dropped" };
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

    case "GET_RELAY_SIGNER":
      return { address: getRelaySignerAddress() };

    case "SET_RELAY_SIGNER_KEY": {
      const ok = importRelaySignerKey(msg.privateKey ?? "");
      return { ok, address: ok ? getRelaySignerAddress() : undefined };
    }

    case "REPORT_PAGE":
    case "REPORT_AD":
      return { ok: true };

    case "DRAIN_CLAIMS_ONLY": {
      // Drain rawImpressionQueue → claimQueue (build hashed claims) WITHOUT settling.
      // Called by signForRelay() before SUBMIT_CLAIMS so built claims are available.
      try {
        const stored2 = await chrome.storage.local.get(["claimBuilderMode", "rawImpressionQueue"]);
        const rawQueue: any[] = stored2.rawImpressionQueue ?? [];
        if ((stored2.claimBuilderMode ?? "per-impression") !== "aggregated" || rawQueue.length === 0) {
          return { ok: true, drainedCount: 0 };
        }
        const MAX_IMPRESSIONS_PER_CLAIM = 250;
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
            // L-2: keccak256(abi.encode(...)) — 10-field (alpha-5 +stakeRootUsed) preimage, actionType=0, clickSessionHash=ZeroHash
            const claimHash = computeClaimHash({
              campaignId: campaignIdBig, publisher, user: ua,
              eventCount: impressionCount, ratePlanck: clearingCpm, actionType: 0, clickSessionHash: ZeroHash, nonce, previousClaimHash: prevHash, stakeRootUsed: ZeroHash,
            });
            existingQueue.push({
              campaignId: cid, publisher,
              eventCount: impressionCount.toString(), ratePlanck: cpm,
              actionType: "0", clickSessionHash: ZeroHash,
              nonce: nonce.toString(), previousClaimHash: prevHash,
              claimHash, zkProof: "0x", nullifier: ZeroHash, stakeRootUsed: ZeroHash, actionSig: "0x", userAddress: ua,
            });
            chain = { lastNonce: Number(nonce), lastClaimHash: claimHash };
          }
          await chrome.storage.local.set({
            [chainKey]: { userAddress: ua, campaignId: cid, lastNonce: chain.lastNonce, lastClaimHash: chain.lastClaimHash },
          });
        }
        await chrome.storage.local.set({ claimQueue: existingQueue, rawImpressionQueue: [] });
        return { ok: true, drainedCount: rawQueue.length };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

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

                // L-2: 10-field (alpha-5 +stakeRootUsed) preimage hashed with keccak256(abi.encode(...)) to match
                // DatumClaimValidator.sol check 8 on alpha-4 EVM.
                // CPM view impressions: actionType=0, clickSessionHash=ZeroHash
                const claimHash = computeClaimHash({
                  campaignId: campaignIdBig, publisher, user: ua,
                  eventCount: impressionCount, ratePlanck: clearingCpm, actionType: 0, clickSessionHash: ZeroHash, nonce, previousClaimHash: prevHash, stakeRootUsed: ZeroHash,
                });

                existingQueue.push({
                  campaignId: cid,
                  publisher,
                  eventCount: impressionCount.toString(),
                  ratePlanck: cpm,
                  actionType: "0",
                  clickSessionHash: ZeroHash,
                  nonce: nonce.toString(),
                  previousClaimHash: prevHash,
                  claimHash,
                  zkProof: "0x",
                  nullifier: ZeroHash,
                  stakeRootUsed: ZeroHash,
                  actionSig: "0x",
                  userAddress: ua,
                });
                console.log(`[datum-daemon] built aggregated claim: campaign=${cid} nonce=${nonce} impressionCount=${impressionCount}`);

                chain = { lastNonce: Number(nonce), lastClaimHash: claimHash };
              }

              await chrome.storage.local.set({
                [chainKey]: { userAddress: ua, campaignId: cid, lastNonce: chain.lastNonce, lastClaimHash: chain.lastClaimHash },
              });
            }

            const newClaimCount = existingQueue.length - (qs2.claimQueue?.length ?? 0);
            const breakdown = Array.from(groups.entries())
              .map(([k, imps]) => `campaign${k.split(":")[0]}×${imps.length}imp→${Math.ceil(imps.length / MAX_IMPRESSIONS_PER_CLAIM)}claim`)
              .join(", ");
            await chrome.storage.local.set({ claimQueue: existingQueue, rawImpressionQueue: [] });
            console.log(`[datum-daemon] Aggregated ${rawQueue.length} raw impressions → ${newClaimCount} new claims (${breakdown})`);
            console.log(`[datum-daemon] Each claim carries eventCount>1 — settlement pays eventCount×ratePlanck per claim`);
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

        await writeClaimStatus({
          phase: "submitting",
          path: "relay-gasless",
          campaigns: batches.map((b: any) => Number(b.campaignId)),
          claimCount: batches.reduce((n: number, b: any) => n + b.claims.length, 0),
        });

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
            const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId, 0);
            const expectedFirst = onChainNonce + 1n;
            const actualFirst: bigint = b.claims[0].nonce;
            const allNonces = b.claims.map((c: any) => c.nonce.toString()).join(",");
            console.log(`[datum-daemon] Pre-submit campaign ${cid}: on-chain=${onChainNonce}, local nonces=[${allNonces}], expected first=${expectedFirst}`);
            // Also fetch on-chain lastClaimHash to verify the hash chain is intact
            const onChainHash: string = onChainNonce > 0n
              ? await settlement.lastClaimHash(b.user, b.campaignId, 0)
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
              const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId, 0);
              const expectedNonce = onChainNonce + 1n;
              const expectedPrevHash: string = onChainNonce > 0n
                ? await settlement.lastClaimHash(b.user, b.campaignId, 0)
                : "0x0000000000000000000000000000000000000000000000000000000000000000";
              const firstClaim = b.claims[0];
              const claimStruct = {
                campaignId: firstClaim.campaignId,
                publisher: firstClaim.publisher,
                eventCount: firstClaim.eventCount,
                ratePlanck: firstClaim.ratePlanck,
                actionType: firstClaim.actionType ?? 0,
                clickSessionHash: firstClaim.clickSessionHash ?? ZeroHash,
                nonce: firstClaim.nonce,
                previousClaimHash: firstClaim.previousClaimHash,
                claimHash: firstClaim.claimHash,
                zkProof: firstClaim.zkProof,
                nullifier: firstClaim.nullifier ?? ZeroHash,
                stakeRootUsed: ZeroHash,
                actionSig: firstClaim.actionSig ?? "0x",
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
          // #5 PoW: the alpha-5 validator fail-closes with code 27 unless each claim's
          // powNonce satisfies the DatumPowEngine target. enforcePow is on (trivial
          // difficulty), so solve each claim's nonce inline before submit.
          try {
            const powEngine = getPowEngineContract(s.contractAddresses, provider);
            if (powEngine && (await powEngine.enforcePow())) {
              let solvedCount = 0;
              for (const b of chunk) {
                for (const c of b.claims) {
                  const target = BigInt((await powEngine.powTargetForUser(b.user, c.eventCount)).toString());
                  const solved = solvePowNonce(c.claimHash, target);
                  if (solved) { c.powNonce = solved; solvedCount++; }
                  else console.warn(`[datum-daemon] PoW unsolved for campaign ${b.campaignId} nonce ${c.nonce}`);
                }
              }
              console.log(`[datum-daemon] PoW solved for ${solvedCount} claim(s)`);
            }
          } catch (e) {
            console.warn("[datum-daemon] PoW solve step failed (submitting as-is):", e);
          }

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
                onChainNonce = await settlement.lastNonce(b.user, b.campaignId, 0);
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
                  const onChainHash: string = await settlement.lastClaimHash(b.user, b.campaignId, 0);
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
                  const onChainHash: string = await settlement.lastClaimHash(b.user, b.campaignId, 0);
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
                      ? await settlement.lastClaimHash(b.user, b.campaignId, 0)
                      : "0x0000000000000000000000000000000000000000000000000000000000000000";
                    const fc = b.claims[0];
                    const [vOk, vCode]: [boolean, number] = await cv.validateClaim(
                      { campaignId: fc.campaignId, publisher: fc.publisher, eventCount: fc.eventCount, ratePlanck: fc.ratePlanck, actionType: fc.actionType ?? 0, clickSessionHash: fc.clickSessionHash ?? ZeroHash, nonce: fc.nonce, previousClaimHash: fc.previousClaimHash, claimHash: fc.claimHash, zkProof: fc.zkProof, nullifier: fc.nullifier ?? ZeroHash, stakeRootUsed: fc.stakeRootUsed ?? ZeroHash, actionSig: fc.actionSig ?? "0x", powNonce: fc.powNonce ?? ZeroHash },
                      b.user, expectedNonce2, expectedPrevHash2,
                    );
                    if (!vOk) rejectReason = REJECTION_REASONS[vCode] ?? `code ${vCode}`;
                  } catch { /* RPC failed — use generic message */ }
                }
                // validateClaim passed (or was unavailable) → the revert is settlement-
                // level (bare require, no reason data). Probe the readable gates to name it.
                if (rejectReason === "nonce chain invalid or budget exhausted") {
                  const fc0 = b.claims[0];
                  const probed = await probeSettlementRevert(
                    s.contractAddresses, provider, b.campaignId,
                    { publisher: fc0.publisher, ratePlanck: BigInt(fc0.ratePlanck), actionType: Number(fc0.actionType ?? 0), eventCount: BigInt(fc0.eventCount ?? 1) },
                    relayWallet.address,
                  );
                  rejectReason = probed ?? "validator + all readable gates OK; settleClaims reverted with no reason data — inspect the relay tx on Blockscout";
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
          await writeClaimStatus({ phase: "failed", error: lastTxError, settledCount: totalSettled });
          return { ok: false, error: lastTxError };
        }
        if (totalSettled > 0) await _queue.removeSettled(userAddress, settledNonces);
        console.log(`[datum-daemon] DAEMON_SUBMIT_CLAIMS: settleClaims settled ${totalSettled} claims for ${userAddress.slice(0, 10)}…`);
        await writeClaimStatus({ phase: "settled", settledCount: totalSettled });
        return { ok: true, settledCount: totalSettled };
      } catch (err) {
        console.error("[datum-daemon] DAEMON_SUBMIT_CLAIMS error:", err);
        await writeClaimStatus({ phase: "failed", error: String(err) });
        return { ok: false, error: String(err) };
      }
    }

    case "WALLET_CREATE":
    case "WALLET_IMPORT":
    case "WALLET_UNLOCK":
    case "WALLET_LOCK":
    case "WALLET_IS_UNLOCKED":
    case "WALLET_ADD_HD_ACCOUNT":
    case "WALLET_ADD_IMPORTED":
    case "WALLET_SET_ACTIVE":
    case "WALLET_REENCRYPT":
    case "WALLET_SIGN_TRANSACTION":
    case "WALLET_SIGN_TYPED_DATA":
    case "WALLET_PERSONAL_SIGN": {
      if (!_walletOffscreen) {
        return { type: "WALLET_RESULT", requestId: msg.requestId, ok: false, error: "daemon-not-ready" };
      }
      return _walletOffscreen.handleWalletMessage(msg);
    }

    // ── Everything else → the ONE shared router ──────────────────────────────
    // The service worker and this daemon call the same routeMessage(msg, sender,
    // env). The cases above are the demo-only / divergent pre-router: in-page
    // pine + offscreen-wallet emulation (PINE_*, WALLET_*), the local gasless
    // relay settle path (DAEMON_SUBMIT_CLAIMS / DRAIN_CLAIMS_ONLY), aggregated
    // claim-building (IMPRESSION_RECORDED), the demo relay signer, and a few
    // stubs the demo deliberately overrides (CHECK_PUBLISHER_ALLOWLIST, REPORT_*,
    // SETTINGS_UPDATED persist, REQUEST_PUBLISHER_ATTESTATION). Every OTHER
    // background message is handled identically by the shared router via
    // demoEnv, so the two can no longer drift.
    //   • Reply/broadcast shapes (*_RESULT / *_RESPONSE / *_STATUS) flow
    //     daemon→popup, never the other way — ignore them quietly.
    //   • A type neither the pre-router nor the shared router knows comes back
    //     as the router's unknown-type error — keep the visible net and log it.
    default: {
      const t = String(msg?.type ?? "");
      if (t === "" || /_(RESULT|RESPONSE|STATUS)$/.test(t)) return undefined;
      const res = await routeMessage(msg, DEMO_SENDER, demoEnv);
      if (res && typeof res === "object" && (res as { error?: string }).error === "unknown message type") {
        console.warn(`[daemon] unhandled message: ${t} — not in the demo pre-router or the shared router`);
        return { ok: false, error: `demo daemon: unhandled message "${t}"` };
      }
      return res;
    }
  }
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
  // Only the singletons the daemon still reads directly: the poller + queue (debug
  // panel, DAEMON_SUBMIT_CLAIMS), the interest profile (browse simulator), and the
  // in-page offscreen-wallet pair. Prefs / auction / matcher / attestation are now
  // reached through the shared routeMessage (which imports them itself), so the
  // daemon no longer holds its own refs to them.
  const [
    { campaignPoller },
    { claimQueue },
    { interestProfile },
    walletDispatcherMod,
    walletOffscreenMod,
  ] = await Promise.all([
    import("@ext/background/campaignPoller"),
    import("@ext/background/claimQueue"),
    import("@ext/background/interestProfile"),
    import("@ext/background/wallet/rpcDispatcher"),
    import("@ext/offscreen/wallet-dispatch"),
  ]);

  _poller    = campaignPoller;
  _queue     = claimQueue;
  _interest  = interestProfile;
  _walletDispatcher = walletDispatcherMod;
  _walletOffscreen  = walletOffscreenMod;

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
