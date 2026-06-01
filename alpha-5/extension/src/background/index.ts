// DATUM background service worker entry point
// Handles alarms, message routing, and scheduled tasks.

import { Wallet, Contract, hexlify, keccak256, solidityPacked } from "ethers";
import { campaignPoller } from "./campaignPoller";
import { startEarningsListener, stopEarningsListener, handleEarningsAlarm, EARNINGS_ALARM } from "./earningsListener";
import { claimQueue } from "./claimQueue";
import { claimBuilder, setProveZk } from "./claimBuilder";
import { proveZk } from "./zkProve";
import { requestPublisherAttestation } from "./publisherAttestation";
import { getPreferences, updatePreferences } from "./userPreferences";
import { cleanupTerminalChains } from "./behaviorChain";
import { timelockMonitor } from "./timelockMonitor";
import { ContentToBackground, PopupToBackground } from "@shared/messages";
import { loadIdleTimeoutSetting } from "./wallet/unlock";
import { handleProviderRequest } from "./wallet/providerHandler";
import { normalizeOrigin } from "./wallet/permissions";
import { NETWORK_CONFIGS } from "@shared/networks";
import DatumAttestationVerifierAbi from "@shared/abis/DatumAttestationVerifier.json";
import { encryptPrivateKey, decryptPrivateKey, EncryptedWalletData, installIdleLockListener } from "@shared/walletManager";
import { solvePow } from "./powSolver";
import { getPaymentVaultContract, getSettlementContract, getPineProvider, getReadProvider } from "@shared/contracts";
import { refreshPhishingList } from "@shared/phishingList";
// The ONE message router — both the service worker (here) and the demo daemon
// call routeMessage(msg, sender, env). getSettings + chainIdForNetwork are shared
// helpers that used to live in this file; they now live with the router.
import { routeMessage, EnvContext, getSettings, chainIdForNetwork } from "./router";

// Install the snarkjs-backed ZK prover into claimBuilder (service-worker only).
// claimBuilder itself is snarkjs-free so the demo can import it; the demo never
// calls setProveZk, so its ZK-required campaigns get an empty proof. See
// claimBuilder.setProveZk / zkProve.ts.
setProveZk(proveZk);

// -------------------------------------------------------------------------
// Alarm names
// -------------------------------------------------------------------------

const ALARM_POLL_CAMPAIGNS = "pollCampaigns";
const ALARM_STATUS_REFRESH = "statusRefresh";
const ALARM_FLUSH_CLAIMS = "flushClaims";

// -------------------------------------------------------------------------
// Startup: register alarms and restore state
// -------------------------------------------------------------------------

// A13-fix: install the wallet idle-lock alarm listener at top-level so it's
//          registered even if the service worker is spun up by a popup connect
//          rather than onInstalled/onStartup. Idempotent.
installIdleLockListener();

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[DATUM] Extension installed/updated");
  await loadIdleTimeoutSetting();
  await initAlarms();
  await immediateInitialPoll();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[DATUM] Extension started");
  // XM-14: Flag that auto-submit was deauthorized (session password lost on SW restart)
  await chrome.storage.local.set({ autoSubmitDeauthNotice: true });
  // XL-5: Clean up orphaned encrypted auto-submit key (session password is gone)
  await chrome.storage.local.remove("autoSubmitKeyEncrypted");
  // Restore the user's auto-lock idle timeout into the wallet module's
  // in-memory cache; offscreen wallet will re-lock if the previous
  // session expired during the SW downtime.
  await loadIdleTimeoutSetting();
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
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway, settings.usePine ? NETWORK_CONFIGS[settings.network]?.pineChain : undefined, settings.rpcEnabled ?? false);
    } else {
      console.log("[DATUM] Skipping initial poll — no campaigns contract address configured");
    }

    // History tab earnings indexer — kick off live subscription + backfill if a wallet is connected.
    try {
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress: string | undefined = stored.connectedAddress;
      if (userAddress && settings.contractAddresses.settlement) {
        await startEarningsListener({
          rpcUrl: settings.rpcUrl,
          chainId: chainIdForNetwork(settings.network),
          contractAddresses: settings.contractAddresses,
          userAddress,
        });
      }
    } catch (err) {
      console.warn("[DATUM] Earnings listener startup failed (non-fatal):", err);
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
      campaigns:           addrs.campaigns ?? "",
      publishers:          addrs.publishers ?? "",
      governanceV2:        addrs.governanceV2 ?? "",
      settlement:          addrs.settlement ?? "",
      relay:               addrs.relay ?? "",
      pauseRegistry:       addrs.pauseRegistry ?? "",
      timelock:            addrs.timelock ?? "",
      zkVerifier:          addrs.zkVerifier ?? "",
      paymentVault:        addrs.paymentVault ?? "",
      budgetLedger:        addrs.budgetLedger ?? "",
      // deployed-addresses.json uses "campaignLifecycle"; ContractAddresses uses "lifecycle"
      lifecycle:           addrs.campaignLifecycle ?? addrs.lifecycle ?? "",
      attestationVerifier: addrs.attestationVerifier ?? "",
      claimValidator:      addrs.claimValidator ?? "",
      tokenRewardVault:    addrs.tokenRewardVault ?? "",
      publisherStake:      addrs.publisherStake ?? "",
      challengeBonds:      addrs.challengeBonds ?? "",
      publisherGovernance: addrs.publisherGovernance ?? "",
      parameterGovernance: addrs.parameterGovernance ?? "",
      clickRegistry:       addrs.clickRegistry ?? "",
      governanceRouter:    addrs.governanceRouter ?? "",
      council:             addrs.council ?? "",
    };
  } catch {
    return null;
  }
}

async function initAlarms() {
  const settings = await getSettings();

  // Clear before recreating — chrome alarms have a minimum 1-min delay
  await chrome.alarms.clear(ALARM_POLL_CAMPAIGNS);
  await chrome.alarms.clear(ALARM_STATUS_REFRESH);

  // Full campaign poll (event discovery + metadata): every 5 min
  await chrome.alarms.create(ALARM_POLL_CAMPAIGNS, {
    periodInMinutes: 5,
    delayInMinutes: 0,
  });

  // Lightweight status-only refresh for known campaigns: every 1 min
  // Keeps bidCpm / remainingBudget / status current between full polls so
  // users earn from known campaigns without waiting for discovery to complete.
  await chrome.alarms.create(ALARM_STATUS_REFRESH, {
    periodInMinutes: 1,
    delayInMinutes: 1,
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
  if (alarm.name === ALARM_STATUS_REFRESH) {
    const settings = await getSettings();
    if (settings.contractAddresses.campaigns) {
      await campaignPoller.refreshStatus(settings.rpcUrl, settings.contractAddresses, settings.usePine ? NETWORK_CONFIGS[settings.network]?.pineChain : undefined, settings.rpcEnabled ?? false);
    }
    // Periodic auto-sweep: runs every minute regardless of settlement activity.
    // Requires wallet authorized for auto-submit (session key in memory).
    try {
      const stored = await chrome.storage.local.get("connectedAddress");
      const userAddress: string | undefined = stored.connectedAddress;
      const privateKey = await getAutoSubmitKey();
      if (userAddress && privateKey) {
        const provider = await getReadProvider(settings.rpcUrl, settings.usePine ?? false, NETWORK_CONFIGS[settings.network]?.pineChain, { rpcAllowed: settings.rpcEnabled ?? false });
        const wallet = new Wallet(privateKey, provider);
        await tryAutoSweep(settings, wallet, userAddress);
      }
    } catch { /* non-critical */ }
    return;
  }

  if (alarm.name === ALARM_POLL_CAMPAIGNS) {
    await refreshPhishingList();
    const settings = await getSettings();
    if (settings.contractAddresses.campaigns) {
      await campaignPoller.poll(settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway, settings.usePine ? NETWORK_CONFIGS[settings.network]?.pineChain : undefined, settings.rpcEnabled ?? false);
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
        const provider = await getReadProvider(settings.rpcUrl, settings.usePine ?? false, NETWORK_CONFIGS[settings.network]?.pineChain, { rpcAllowed: settings.rpcEnabled ?? false });
        const currentBlock = await provider.getBlockNumber();
        if (stored.signedBatches.deadline <= currentBlock) {
          await chrome.storage.local.remove("signedBatches");
          console.log("[DATUM] Removed expired signed relay batches");
        }
      }
    } catch { /* non-critical */ }

    // H2: Poll timelock for pending admin changes
    if (settings.contractAddresses.timelock) {
      await timelockMonitor.poll(settings.rpcUrl, settings.contractAddresses, settings.usePine ? NETWORK_CONFIGS[settings.network]?.pineChain : undefined, settings.rpcEnabled ?? false);
    }
  }
  if (alarm.name === ALARM_FLUSH_CLAIMS) {
    await autoFlushDirect();
  }
  if (alarm.name === EARNINGS_ALARM) {
    const settings = await getSettings();
    if (settings.contractAddresses.settlement) {
      await handleEarningsAlarm({
        rpcUrl: settings.rpcUrl,
        chainId: chainIdForNetwork(settings.network),
        contractAddresses: settings.contractAddresses,
      });
    }
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

// -------------------------------------------------------------------------
// Service-worker EnvContext — wraps the SW-specific capabilities the shared
// router needs: offscreen-pine reads, the live earnings indexer, chrome.alarms
// re-arm, the encrypted auto-submit session, EIP-1193 signing with the popup
// approval flow, the content-script provider bridge, and relay-fetched
// publisher attestation. routeMessage(msg, sender, swEnv) is the ONE switch;
// the demo daemon builds its own env and calls the same router.
// -------------------------------------------------------------------------

const swEnv: EnvContext = {
  async readProvider(settings, opts) {
    return getReadProvider(
      settings.rpcUrl,
      settings.usePine ?? false,
      NETWORK_CONFIGS[settings.network]?.pineChain,
      opts ? { rpcAllowed: opts.rpcAllowed ?? false } : undefined,
    );
  },

  async pineProvider(settings) {
    const pineChain = settings.usePine ? NETWORK_CONFIGS[settings.network]?.pineChain : undefined;
    if (!pineChain) return null;
    return getPineProvider(pineChain);
  },

  earnings: {
    start: (opts) => startEarningsListener(opts),
    stop: () => stopEarningsListener(),
  },

  onSettingsUpdated: () => initAlarms(),

  autoSubmit: {
    authorize: (password) => authorizeAutoSubmit(password),
    revoke: () => revokeAutoSubmit(),
    isAuthorized: () => isAutoSubmitAuthorized(),
  },

  signing: {
    async signTypedData(msg, sender) {
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
    },

    async personalSign(msg, sender) {
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
    },

    async sendTransaction(msg, sender) {
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
        const provider = await getReadProvider(s3.rpcUrl, s3.usePine ?? false, NETWORK_CONFIGS[s3.network]?.pineChain);
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
    },

    async resolveApproval(msg) {
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
    },
  },

  async walletProvider(msg, sender) {
    // EIP-1193 provider RPC from a content script. The sender's origin
    // (`sender.origin` — pulled from the tab the script runs in, NOT from any
    // field the page could control) drives the permission gate.
    const origin = normalizeOrigin(sender.origin ?? sender.url ?? "");
    if (!origin) {
      return {
        type: "WALLET_PROVIDER_RESPONSE",
        requestId: msg.requestId,
        ok: false,
        error: { code: 4100, message: "Provider RPC requires a page-context sender" },
      };
    }
    const result = await handleProviderRequest({ origin, method: msg.method, params: msg.params });
    return {
      type: "WALLET_PROVIDER_RESPONSE",
      requestId: msg.requestId,
      ok: result.ok,
      result: result.ok ? result.result : undefined,
      error: result.ok ? undefined : result.error,
    };
  },

  async requestAttestation(args) {
    const r = await requestPublisherAttestation(
      args.publisherAddress,
      args.campaignId,
      args.userAddress,
      args.claimsHash,
      args.deadlineBlock,
    );
    return { signature: r.signature || undefined, error: r.error };
  },
};

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground | PopupToBackground, sender, sendResponse) => {
    routeMessage(msg, sender, swEnv)
      .then(sendResponse)
      .catch((err) => {
        console.error("[DATUM background] message error:", err);
        sendResponse({ error: String(err) });
      });
    return true; // async response
  }
);

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
        const provider = await getReadProvider(settings.rpcUrl, settings.usePine ?? false, NETWORK_CONFIGS[settings.network]?.pineChain, { rpcAllowed: settings.rpcEnabled ?? false });
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

    const provider = await getReadProvider(settings.rpcUrl, settings.usePine ?? false, NETWORK_CONFIGS[settings.network]?.pineChain, { rpcAllowed: settings.rpcEnabled ?? false });
    const wallet = new Wallet(privateKey, provider);
    const attestationVerifier = new Contract(
      settings.contractAddresses.attestationVerifier,
      DatumAttestationVerifierAbi.abi,
      wallet
    );

    // A1-fix: deadlineBlock binds the publisher cosig to an expiry. ~5 min
    //         at 6s/block = 50 blocks. Generous margin for relay queuing.
    const ATTEST_DEADLINE_BLOCKS = 50n;
    let currentBlock: bigint;
    try {
      currentBlock = BigInt(await provider.getBlockNumber());
    } catch {
      currentBlock = 0n;
    }
    const deadlineBlock = currentBlock + ATTEST_DEADLINE_BLOCKS;

    // Build AttestedBatch[] — request publisher co-signature for each batch
    // #5: Resolve PoW enforcement status and per-claim difficulty before solving.
    //     Settlement view returns max_uint when enforcePow=false, so any
    //     ZeroHash powNonce passes — no PoW work needed.
    const settlement = getSettlementContract(settings.contractAddresses, provider);
    let powEnforced = false;
    try { powEnforced = await settlement.enforcePow(); } catch { /* old deploy */ }

    const attestedBatches = await Promise.all(batches.map(async (b) => {
      const publisher = b.claims[0]?.publisher ?? "";
      // A1-fix: claimsHash = keccak256(packed claim.claimHash[])
      const claimHashes = b.claims.map((c) => c.claimHash);
      const claimsHash = keccak256(solidityPacked(
        new Array(claimHashes.length).fill("bytes32"),
        claimHashes,
      ));
      let publisherSig = "0x";
      try {
        const attestResult = await requestPublisherAttestation(
          publisher,
          b.campaignId.toString(),
          b.user,
          claimsHash,
          deadlineBlock,
        );
        if (attestResult.signature) publisherSig = attestResult.signature;
        if (attestResult.error) console.warn(`[DATUM] Auto-flush attestation warning for campaign ${b.campaignId}: ${attestResult.error}`);
      } catch {
        // Attestation unavailable — degraded trust mode
      }

      // #5: solve PoW per claim before assembling the batch. Skipped entirely
      //      when enforcePow is off (target = max_uint, any nonce passes).
      const solvedClaims = await Promise.all(b.claims.map(async (c) => {
        let powNonce = c.powNonce;
        if (powEnforced) {
          try {
            const target = BigInt((await settlement.powTargetForUser(b.user, c.eventCount)).toString());
            const solved = await solvePow(c.claimHash, target);
            if (solved) powNonce = solved;
            else console.warn(`[DATUM] Auto-flush: PoW search budget exhausted for campaign ${b.campaignId} nonce ${c.nonce}`);
          } catch (err) {
            console.warn(`[DATUM] Auto-flush: PoW solve failed:`, err);
          }
        }
        return {
          campaignId: c.campaignId,
          publisher: c.publisher,
          eventCount: c.eventCount,
          ratePlanck: c.ratePlanck,
          actionType: c.actionType,
          clickSessionHash: c.clickSessionHash,
          nonce: c.nonce,
          previousClaimHash: c.previousClaimHash,
          claimHash: c.claimHash,
          zkProof: c.zkProof,
          nullifier: c.nullifier,
          actionSig: c.actionSig,
          powNonce,
        };
      }));

      return {
        user: b.user,
        campaignId: b.campaignId,
        claims: solvedClaims,
        deadlineBlock,
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
    // (`settlement` was already constructed earlier for the PoW target lookup)
    const settledNonces = new Map<string, bigint[]>();
    for (const b of batches) {
      const cid = b.campaignId.toString();
      try {
        const actionType = b.claims[0]?.actionType ?? 0;
        const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId, actionType);
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

// serializeBatches now lives in ./router (shared with the demo daemon).
