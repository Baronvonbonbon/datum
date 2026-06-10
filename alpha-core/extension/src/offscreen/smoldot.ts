// Pine host — lives inside the extension's offscreen document.
//
// Why offscreen: the MV3 service worker can't load WebAssembly with the
// runtime-compile permissions smoldot needs (no `wasm-eval`). The offscreen
// document is a long-lived page-context with full DOM + WASM capabilities,
// which is exactly the surface PineProvider was designed for.
//
// Lifecycle:
//   1. Background sends PINE_INIT once on extension start (or first
//      use). We construct PineProvider, call connect(), and start
//      broadcasting PINE_STATUS on every SyncStep transition.
//   2. Background sends PINE_RPC_REQUEST for every chain read. We
//      forward to provider.request(); reply with PINE_RPC_RESULT.
//   3. Background sends PINE_STATUS_SUBSCRIBE to (re-)broadcast the
//      current status — useful when a fresh popup opens and wants to
//      paint the syncing chip without waiting for the next SyncStep.
//
// PineProvider holds an in-memory TxPool + LogIndexer; both live as long
// as the offscreen document does. The offscreen doc is torn down when
// the extension stops (browser close or extension reload); a new INIT on
// next start cold-starts pine from scratch (~30 s warm-up).

import { PineProvider, type SyncStep } from "pine-rpc";
import type {
  BackgroundToOffscreen,
  OffscreenToBackground,
  PineStatus,
} from "@shared/messages";

/// Single pine instance for the lifetime of this offscreen document.
/// We never destroy + recreate; if connect rejects, the error is recorded
/// in `_status` and surfaced via PINE_STATUS broadcasts.
let _provider: PineProvider | null = null;

/// Mirror of what we'd report on a PINE_STATUS broadcast. Mutated by the
/// SyncStep callback, the connect() resolution, and (rarely) the
/// connect() rejection.
let _status: PineStatus = {
  state: "idle",
  step: "",
  peers: 0,
  finalizedHead: 0,
  indexedFromBlock: 0,
};

/// `connect()` promise so concurrent PINE_INIT calls reuse the same
/// connection attempt instead of double-initializing. Null after a
/// terminal state (connected or errored).
let _connectPromise: Promise<void> | null = null;

/// Public entry point — invoked by offscreen.ts message dispatcher.
/// Returns the reply payload for OffscreenToBackground; undefined for
/// fire-and-forget messages (status subscribe).
export async function handlePineMessage(
  msg: BackgroundToOffscreen
): Promise<OffscreenToBackground | undefined> {
  switch (msg.type) {
    case "PINE_INIT":
      await initPine(msg.chain);
      return { type: "PINE_STATUS", status: { ..._status } };

    case "PINE_RPC_REQUEST": {
      try {
        const provider = await ensureProvider();
        const result = await provider.request({
          method: msg.method,
          params: msg.params as any,
        });
        return {
          type: "PINE_RPC_RESULT",
          requestId: msg.requestId,
          result,
        };
      } catch (err: any) {
        // EIP-1193 errors carry { code, message, data? }; normalize.
        const code = typeof err?.code === "number" ? err.code : -32603;
        const message = typeof err?.message === "string" ? err.message : String(err);
        return {
          type: "PINE_RPC_RESULT",
          requestId: msg.requestId,
          error: { code, message, data: err?.data },
        };
      }
    }

    case "PINE_STATUS_SUBSCRIBE":
      // Broadcast current status. The caller (background) will re-emit to
      // any popup/page listeners. Pure read; no provider work.
      broadcastStatus();
      return { type: "PINE_STATUS", status: { ..._status } };

    default:
      return undefined;
  }
}

async function initPine(chain: string): Promise<void> {
  if (_provider) {
    // Already constructed. If state is connecting, wait on the in-flight
    // promise. If ready / error, return immediately so the caller sees the
    // current status.
    if (_connectPromise) await _connectPromise;
    return;
  }

  _provider = new PineProvider({ chain: chain as any });
  setStatus({ state: "connecting", step: "starting" });

  // Capture the connect promise so subsequent PINE_INIT calls don't double
  // up. Errors are caught and reflected via _status; we don't throw out of
  // initPine because the caller (offscreen dispatch) doesn't need to fail.
  _connectPromise = (async () => {
    try {
      await _provider!.connect((step: SyncStep) => {
        setStatus({ state: "connecting", step: String(step) });
      });
      // Seed indexed-from block with the head at connect time; UI uses
      // this as the lower bound for "history begins at" footers.
      const head = await readBlockNumber();
      setStatus({
        state: "ready",
        step: "connected",
        finalizedHead: head,
        indexedFromBlock: head,
      });
      // Keep finalizedHead live. Polling is cheap (chainHead subscription
      // already updates pine internally; we just sample).
      startHeadPoll();
    } catch (err: any) {
      setStatus({
        state: "error",
        step: "connect-failed",
        error: String(err?.message ?? err),
      });
    } finally {
      _connectPromise = null;
    }
  })();

  await _connectPromise;
}

async function ensureProvider(): Promise<PineProvider> {
  if (!_provider) {
    throw new Error("pine not initialized — background must send PINE_INIT first");
  }
  if (_status.state === "error") {
    throw new Error(`pine connect failed: ${_status.error ?? "unknown"}`);
  }
  if (_status.state !== "ready" && _connectPromise) {
    await _connectPromise;
  }
  if (_status.state !== "ready") {
    throw new Error(`pine not ready (state=${_status.state})`);
  }
  return _provider;
}

/// Mutate _status and emit a PINE_STATUS broadcast. Background can fan out
/// to interested popup/UI listeners; offscreen does not maintain its own
/// subscriber list.
function setStatus(patch: Partial<PineStatus>): void {
  _status = { ..._status, ...patch };
  broadcastStatus();
}

function broadcastStatus(): void {
  const msg: OffscreenToBackground = { type: "PINE_STATUS", status: { ..._status } };
  // chrome.runtime.sendMessage with no callback fires-and-forgets; if the
  // background isn't listening (popup-only state), the message is dropped
  // silently. That's the desired behaviour for a status broadcast.
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    // Extension teardown in progress — nothing to do.
  }
}

async function readBlockNumber(): Promise<number> {
  if (!_provider) return 0;
  try {
    const hex = (await _provider.request({ method: "eth_blockNumber", params: [] })) as string;
    return Number(BigInt(hex));
  } catch {
    return 0;
  }
}

/// Poll finalized head every ~6 s (Paseo block time). Cheap because pine's
/// chainHead subscription already tracks the latest finalized number; this
/// only reads it.
function startHeadPoll(): void {
  const tick = async () => {
    if (!_provider || _status.state !== "ready") return;
    const head = await readBlockNumber();
    if (head !== _status.finalizedHead) {
      setStatus({ finalizedHead: head });
    }
  };
  // First sample after a short delay so the head we already seeded isn't
  // immediately re-emitted as a duplicate.
  setInterval(tick, 6_000);
}

// ── Test surface ────────────────────────────────────────────────────────
// Exported only so unit tests can reset state between cases. Production
// code should never reach into these.
export const __test = {
  reset(): void {
    _provider = null;
    _connectPromise = null;
    _status = {
      state: "idle",
      step: "",
      peers: 0,
      finalizedHead: 0,
      indexedFromBlock: 0,
    };
  },
  getStatus(): PineStatus {
    return { ..._status };
  },
};
