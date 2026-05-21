// Webapp pine provider — lazy-initialized singleton.
//
// Per design doc §1: pine is the canonical chain access path on every
// surface. Reads + writes go through smoldot via PineProvider. The
// webapp's lib/query.ts splices in RPC history for operator-route
// tiles that opt in (historyAllowed), but the live pipeline is
// always this provider.
//
// Two pine instances coexist when the user has the extension: the
// extension's offscreen-hosted pine (for popup + content-script
// requests) AND this webapp's pine (for unauthenticated reads on
// the public pages). They're independent — neither sees the other's
// TxPool. That's fine: when the page issues a write it routes
// through walletConnector → extension → extension's pine, and the
// webapp's pine catches the resulting on-chain state via its
// chainHead subscription a few seconds later.
//
// Initialization is deferred — we don't pay the smoldot warm-up
// cost during the first paint of Explorer. Hooks call
// `getPineProvider()` lazily; the first call triggers
// `PineProvider.connect()` and resolves once we reach finalized
// head.

import { PineProvider, type SyncStep } from "pine-rpc";

const DEFAULT_CHAIN = "paseo-asset-hub";

export type PineStatus = {
  /// "idle" before init; "connecting" while smoldot warms; "ready"
  /// after first finalized block; "error" if connect rejected.
  state: "idle" | "connecting" | "ready" | "error";
  /// Most recent SyncStep label. Empty before connect.
  step: string;
  /// Peer count, 0 before chainHead fires.
  peers: number;
  /// Latest finalized block number observed.
  finalizedHead: number;
  /// Block at which pine considers its LogIndexer warm. UI uses this
  /// as the lower-bound when computing "history begins at block N"
  /// footers on telemetry tiles.
  indexedFromBlock: number;
  /// Populated only when state === "error".
  error?: string;
};

let _provider: PineProvider | null = null;
let _initPromise: Promise<PineProvider> | null = null;
let _status: PineStatus = {
  state: "idle",
  step: "",
  peers: 0,
  finalizedHead: 0,
  indexedFromBlock: 0,
};

type Listener = (s: PineStatus) => void;
const _listeners = new Set<Listener>();

/// Get the singleton pine provider, initializing on first call.
/// Throws if the connect attempt rejects — caller should catch and
/// surface a "couldn't reach Polkadot peers" state to the user.
export function getPineProvider(): Promise<PineProvider> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const p = new PineProvider({ chain: DEFAULT_CHAIN as any });
    setStatus({ state: "connecting", step: "starting" });
    try {
      await p.connect((step: SyncStep) => {
        setStatus({ state: "connecting", step: String(step) });
      });
      _provider = p;
      const head = await readBlockNumber(p);
      setStatus({
        state: "ready",
        step: "connected",
        finalizedHead: head,
        indexedFromBlock: head,
      });
      startHeadPoll();
      return p;
    } catch (err: any) {
      setStatus({
        state: "error",
        step: "connect-failed",
        error: String(err?.message ?? err),
      });
      // Reset so a retry (e.g. user clicks "reconnect") gets a clean
      // attempt instead of returning the failed promise forever.
      _initPromise = null;
      throw err;
    }
  })();
  return _initPromise;
}

/// Cheap snapshot read. Most callers want this — they don't need
/// the full provider, just to know if pine is ready and what block
/// we're at.
export function getPineStatus(): PineStatus {
  return { ..._status };
}

/// Subscribe to status changes. The callback fires synchronously
/// with the current snapshot, then again on every transition.
/// Returns an unsubscribe function.
export function onPineStatus(listener: Listener): () => void {
  _listeners.add(listener);
  try {
    listener(getPineStatus());
  } catch (err) {
    console.error("[pine] status listener threw on initial emit", err);
  }
  return () => {
    _listeners.delete(listener);
  };
}

/// Convenience JSON-RPC wrapper. Equivalent to
/// `(await getPineProvider()).request(...)`.
export async function pineRpc<T = unknown>(
  method: string,
  params: unknown[] = []
): Promise<T> {
  const p = await getPineProvider();
  return p.request({ method, params: params as any }) as Promise<T>;
}

// ─── Internals ────────────────────────────────────────────────────

function setStatus(patch: Partial<PineStatus>): void {
  _status = { ..._status, ...patch };
  for (const listener of _listeners) {
    try {
      listener({ ..._status });
    } catch (err) {
      console.error("[pine] status listener threw", err);
    }
  }
}

async function readBlockNumber(p: PineProvider): Promise<number> {
  try {
    const hex = (await p.request({
      method: "eth_blockNumber",
      params: [],
    })) as string;
    return Number(BigInt(hex));
  } catch {
    return 0;
  }
}

let _headPollTimer: ReturnType<typeof setInterval> | null = null;

function startHeadPoll(): void {
  if (_headPollTimer) return;
  _headPollTimer = setInterval(async () => {
    if (!_provider || _status.state !== "ready") return;
    const head = await readBlockNumber(_provider);
    if (head !== _status.finalizedHead) setStatus({ finalizedHead: head });
  }, 6_000);
}

// ─── Test surface ─────────────────────────────────────────────────

export const __test = {
  reset(): void {
    if (_headPollTimer) {
      clearInterval(_headPollTimer);
      _headPollTimer = null;
    }
    _provider = null;
    _initPromise = null;
    _listeners.clear();
    _status = {
      state: "idle",
      step: "",
      peers: 0,
      finalizedHead: 0,
      indexedFromBlock: 0,
    };
  },
  setStatus(patch: Partial<PineStatus>): void {
    setStatus(patch);
  },
};
