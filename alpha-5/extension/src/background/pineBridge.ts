// pineBridge — background-side client for the offscreen-hosted pine.
//
// All chain reads from background modules (campaign poller, earnings
// listener, allowlist checks, blocklist checks, etc.) go through
// `pineRpc()`. The bridge:
//   1. Ensures the offscreen document exists (created on first call).
//   2. Drives PINE_INIT once per service-worker lifetime.
//   3. Routes individual JSON-RPC calls via PINE_RPC_REQUEST and
//      resolves Promises when the matching PINE_RPC_RESULT arrives.
//   4. Re-broadcasts PINE_STATUS messages to local listeners (used by
//      the popup's syncing chip).
//
// Design notes:
//   - The service worker can be suspended between callbacks; on the
//     next wake-up `pineRpc` must work without re-asking the popup for
//     consent. The offscreen document is set up to outlive the service
//     worker (Chrome keeps it alive while the extension is loaded).
//   - We use chrome.runtime.sendMessage as the transport because
//     offscreen ↔ background is a standard MV3 message channel. No
//     long-lived port; replies are correlated by requestId.
//   - Status messages are coalesced — listeners receive only the most
//     recent status snapshot; intermediate frames may be dropped.

import type {
  BackgroundToOffscreen,
  OffscreenToBackground,
  PineStatus,
} from "@shared/messages";

const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_CHAIN = "paseo-asset-hub";

/// Whether the bridge has begun creating + initializing the offscreen
/// document for this service-worker lifetime. The Promise resolves
/// after PINE_INIT returns, so callers that await it know the offscreen
/// page is alive (even if pine itself is still warming up).
let _readyPromise: Promise<void> | null = null;

/// Last known status from the offscreen pine. Listeners (popup tabs,
/// background hooks) subscribe via onStatus(); they immediately get the
/// cached value, then live updates.
let _lastStatus: PineStatus = {
  state: "idle",
  step: "",
  peers: 0,
  finalizedHead: 0,
  indexedFromBlock: 0,
};

type StatusListener = (s: PineStatus) => void;
const _statusListeners = new Set<StatusListener>();

/// Subscribe to pine status updates. Returns an unsubscribe function.
/// The listener is invoked synchronously with the current cached status
/// before any future updates arrive.
export function onPineStatus(listener: StatusListener): () => void {
  _statusListeners.add(listener);
  try {
    listener({ ..._lastStatus });
  } catch (err) {
    console.error("[pineBridge] status listener threw on initial emit", err);
  }
  return () => {
    _statusListeners.delete(listener);
  };
}

/// Read the most recent cached status without subscribing.
export function getPineStatus(): PineStatus {
  return { ..._lastStatus };
}

// Long-lived listener for PINE_STATUS broadcasts from the offscreen doc.
// Installed once per service-worker lifetime.
chrome.runtime.onMessage.addListener((msg: OffscreenToBackground) => {
  if (msg.type === "PINE_STATUS") {
    _lastStatus = msg.status;
    for (const listener of _statusListeners) {
      try {
        listener({ ..._lastStatus });
      } catch (err) {
        console.error("[pineBridge] status listener threw", err);
      }
    }
  }
  return false;
});

/// Ensure the offscreen document is created and PINE_INIT has fired.
/// Idempotent; safe to call from every chain-read site without guarding.
export async function ensurePineReady(chain: string = DEFAULT_CHAIN): Promise<void> {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    await ensureOffscreenDocument();
    // PINE_INIT is idempotent on the offscreen side — if pine is already
    // up, it returns the current status. We await the reply so callers
    // that depend on "pine ready" actually wait for it.
    await sendToOffscreen({ type: "PINE_INIT", chain });
  })().catch((err) => {
    // Reset so the next call can retry. Otherwise a transient failure
    // (browser-restart race) would poison the bridge permanently.
    _readyPromise = null;
    throw err;
  });
  return _readyPromise;
}

/// JSON-RPC call against the offscreen pine. Mirrors the EIP-1193
/// `request({ method, params })` shape so callers can swap pine for any
/// EIP-1193 provider in tests.
///
/// Throws an Error if the offscreen pine returns a JSON-RPC error; the
/// error's `.code` and `.data` fields mirror the EIP-1193 ProviderRpcError
/// shape when available.
export async function pineRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  await ensurePineReady();
  const requestId = newRequestId();
  const reply = (await sendToOffscreen({
    type: "PINE_RPC_REQUEST",
    requestId,
    method,
    params,
  })) as OffscreenToBackground | undefined;

  if (!reply || reply.type !== "PINE_RPC_RESULT") {
    throw new Error(`pineRpc(${method}): missing or malformed reply`);
  }
  if (reply.error) {
    const err = new Error(reply.error.message) as Error & {
      code?: number;
      data?: unknown;
    };
    err.code = reply.error.code;
    err.data = reply.error.data;
    throw err;
  }
  return reply.result as T;
}

// ── Internals ───────────────────────────────────────────────────────────

let _offscreenPromise: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (_offscreenPromise) return _offscreenPromise;
  _offscreenPromise = (async () => {
    // chrome.offscreen.hasDocument exists on Chrome >=116; we declared
    // minimum_chrome_version 120 in the manifest, so this is safe.
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // WORKERS reason covers smoldot (which runs inside a worker spawned
      // by the offscreen page). BLOBS covers any FileReader-style IO the
      // existing settlement submit path uses. The MV3 API requires at
      // least one reason from the documented set; we list both to keep
      // the doc alive across both call paths.
      reasons: [
        chrome.offscreen.Reason.WORKERS,
        chrome.offscreen.Reason.BLOBS,
      ],
      justification:
        "Pine smoldot light-client + ZK proof workers + claim signing all need a DOM/WASM context the MV3 service worker cannot provide.",
    });
  })().catch((err) => {
    _offscreenPromise = null;
    throw err;
  });
  return _offscreenPromise;
}

function sendToOffscreen(
  msg: BackgroundToOffscreen
): Promise<OffscreenToBackground | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(reply);
    });
  });
}

let _reqCounter = 0;
function newRequestId(): string {
  _reqCounter = (_reqCounter + 1) | 0;
  return `pine-${Date.now()}-${_reqCounter}`;
}

// ── Test surface ────────────────────────────────────────────────────────
// Exported only so unit tests can reset the module's state between cases.
export const __test = {
  reset(): void {
    _readyPromise = null;
    _offscreenPromise = null;
    _reqCounter = 0;
    _statusListeners.clear();
    _lastStatus = {
      state: "idle",
      step: "",
      peers: 0,
      finalizedHead: 0,
      indexedFromBlock: 0,
    };
  },
  emitStatus(s: PineStatus): void {
    _lastStatus = s;
    for (const listener of _statusListeners) listener({ ...s });
  },
};
