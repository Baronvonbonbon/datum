// eventBus — multicasted chain-log subscriptions.
//
// Pine's getLogs is in-memory but not free: one call per dashboard
// per block, with ~10k blocks of window each, would burn ~1.5s of
// WASM time per block. With multiple dashboards open the cost
// stacks. The bus deduplicates by (address, topic0): a single pine
// poll feeds N subscribers.
//
// Lifecycle per channel:
//   1. First subscriber joins → channel registered. We seed
//      `lastFetchedBlock` to pine's current head and (if
//      historyAllowed + RPC supplied) kick off a one-shot
//      historical fetch.
//   2. Every new finalized block from pine, we fetch
//      `eth_getLogs(fromBlock = lastFetchedBlock + 1, toBlock = head)`
//      and fan the result out to all subscribers.
//   3. Last subscriber unsubscribes → channel torn down. Future
//      subscribers start fresh.
//
// Historical fill: when a subscriber sets `historyAllowed: true` and
// pine's indexedFromBlock is later than requested, we fire a one-
// shot `eth_getLogs` against the operator's configured RPC endpoint
// (rpcSettings) covering [requestedFrom, pineFloor-1]. Subscribers
// see one "historical" emission shortly after subscribe, plus the
// usual live emissions thereafter.

import { onPineStatus, pineRpc, type PineStatus } from "./provider";
import { getRpcEndpoint } from "./rpcSettings";

/// Standard eth_getLogs entry shape. Pine + RPC return this verbatim.
export type EthLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
};

export type LogEmission = {
  /// Logs newly seen since the last emission to this subscriber. For
  /// the first emission this includes historical + live.
  logs: EthLog[];
  /// True iff this batch was assembled with help from the RPC fallback.
  /// Per-emission, not per-channel — a tile that started life with
  /// RPC backfill flips to false on subsequent pine-only updates.
  viaRpc: boolean;
  /// When defined, the subscriber's requested window pre-dates pine's
  /// connect and no RPC fallback was permitted (or available); the
  /// emission's logs start at this block.
  truncatedTo?: number;
};

export type LogSubscriptionOpts = {
  /// Contract address to filter. Lower-case 0x-prefixed.
  address: string;
  /// Topic0 (event signature hash) — the bus dedupes channels by
  /// (address, topic0, ...indexed). Subscribers wanting multiple
  /// distinct events register one subscription per topic0.
  topic0: string;
  /// Optional indexed-parameter filter for topics 1/2/3 (matching
  /// eth_getLogs semantics). For events with indexed user/publisher/
  /// campaign args, set the corresponding slot to the 32-byte left-
  /// padded hex. Use null for "any". Cheaper than client-side
  /// filtering for high-volume topics on busy contracts.
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
  /// Requested window in blocks. Used to compute fromBlock as
  /// `currentBlock - windowBlocks`. Truncated to pine's
  /// indexedFromBlock for end-user tiles.
  windowBlocks: number;
  /// True only on operator routes (per rpcSettings.isOperatorRoute).
  /// When true and pine's window doesn't reach the requested
  /// fromBlock, the bus pulls the older slice via RPC.
  historyAllowed: boolean;
};

/// Convert an EVM address to the topic-encoded form (left-padded to
/// 32 bytes). Use when filtering by an indexed `address`-typed event
/// parameter via `topic1`/`topic2`/`topic3`.
export function addressToTopic(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + hex.padStart(64, "0");
}

type Listener = (emission: LogEmission) => void;

type Channel = {
  key: string; // `${address}:${topic0}:${t1}:${t2}:${t3}`
  address: string;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  subscribers: Set<{ opts: LogSubscriptionOpts; listener: Listener }>;
  /// Highest block already fetched + emitted. We always poll from
  /// `lastFetchedBlock + 1` on the next tick.
  lastFetchedBlock: number;
  /// Lowest block known to be covered by emitted history. Used to
  /// answer late-arriving subscribers whose `windowBlocks` is shorter
  /// than what we've already fetched — they get a slice from our
  /// cache instead of an extra pine call.
  earliestFetchedBlock: number;
  /// Cache of every log we've ever fetched for this channel. Bounded
  /// implicitly by `windowBlocks` — when the channel turns over
  /// (last subscriber leaves), the cache evaporates.
  logs: EthLog[];
  /// True while a fetch is in flight. Prevents overlap when block
  /// ticks arrive faster than the previous fetch resolves.
  fetchInFlight: boolean;
  /// True once at least one subscriber on this channel has received
  /// its bootstrap emission. Live-tick polling waits on this so it
  /// never delivers a "live update" before the subscriber has even
  /// seen its first batch.
  bootstrapped: boolean;
};

const _channels = new Map<string, Channel>();

/// Per-block tick driver. Installed on first subscribe; torn down
/// when the channel map is empty.
let _statusUnsubscribe: (() => void) | null = null;
let _lastSeenHead = 0;

// ─── Public API ────────────────────────────────────────────────────

/// Subscribe to logs for `(address, topic0)`. Returns an unsubscribe
/// function. The listener fires once shortly after subscribe (with
/// historical + initial live data) and then on every new block that
/// produces matching logs.
export function subscribeLogs(
  opts: LogSubscriptionOpts,
  listener: Listener
): () => void {
  const key = channelKey(opts);
  let ch = _channels.get(key);
  if (!ch) {
    ch = {
      key,
      address: opts.address.toLowerCase(),
      topic0: opts.topic0.toLowerCase(),
      topic1: opts.topic1 ?? null,
      topic2: opts.topic2 ?? null,
      topic3: opts.topic3 ?? null,
      subscribers: new Set(),
      lastFetchedBlock: 0,
      earliestFetchedBlock: 0,
      logs: [],
      fetchInFlight: false,
      bootstrapped: false,
    };
    _channels.set(key, ch);
  }

  const sub = { opts, listener };
  ch.subscribers.add(sub);

  // Install the global tick listener lazily — only run pine status
  // subscription while we have at least one channel.
  ensureTickListener();

  // Bootstrap this subscriber immediately so the UI doesn't wait
  // for the next block tick. pollChannel checks
  // `ch.bootstrapped` and skips until at least one bootstrap
  // emission has fired, so the live driver can't deliver an "update"
  // before the subscriber has seen its initial batch.
  void bootstrapSubscriber(ch, sub);

  return () => {
    ch!.subscribers.delete(sub);
    if (ch!.subscribers.size === 0) {
      _channels.delete(key);
      maybeTearDownTickListener();
    }
  };
}

// ─── Internals: tick driver ────────────────────────────────────────

function ensureTickListener(): void {
  if (_statusUnsubscribe) return;
  _statusUnsubscribe = onPineStatus(onPineStatusTick);
}

function maybeTearDownTickListener(): void {
  if (_channels.size > 0) return;
  if (_statusUnsubscribe) {
    _statusUnsubscribe();
    _statusUnsubscribe = null;
  }
  _lastSeenHead = 0;
}

async function onPineStatusTick(status: PineStatus): Promise<void> {
  if (status.state !== "ready") return;
  const head = status.finalizedHead;
  if (head <= _lastSeenHead) return;
  _lastSeenHead = head;
  // Walk a stable snapshot of channels — subscribers might add or
  // remove during a tick, but the map iteration is safe because we
  // collect the current channels into an array first.
  const channels = Array.from(_channels.values());
  await Promise.all(channels.map((ch) => pollChannel(ch, head)));
}

async function pollChannel(ch: Channel, head: number): Promise<void> {
  if (ch.fetchInFlight) return;
  // Don't poll a channel that hasn't completed its bootstrap.
  // bootstrapSubscriber owns the initial emission; pollChannel only
  // handles the live tail afterward.
  if (!ch.bootstrapped) return;
  if (ch.lastFetchedBlock >= head) return;
  ch.fetchInFlight = true;
  try {
    const fromBlock = ch.lastFetchedBlock + 1;
    const newLogs = await pineGetLogs(ch, fromBlock, head);
    if (newLogs.length > 0) {
      ch.logs.push(...newLogs);
    }
    ch.lastFetchedBlock = head;
    if (newLogs.length > 0) {
      for (const sub of ch.subscribers) {
        // Trim the slice we deliver to each subscriber by their
        // requested window. A subscriber asking for 100 blocks gets
        // logs from at most `head - 100`; older logs the channel may
        // hold (because a sibling subscriber wanted more) are not
        // their concern.
        const sliceFrom = Math.max(0, head - sub.opts.windowBlocks);
        const slice = newLogs.filter(
          (l) => Number(BigInt(l.blockNumber)) >= sliceFrom
        );
        if (slice.length === 0) continue;
        try {
          sub.listener({ logs: slice, viaRpc: false });
        } catch (err) {
          console.error("[eventBus] subscriber threw", err);
        }
      }
    }
  } catch (err) {
    // Pine errors are typically transient (peer churn, head reorg
    // mid-fetch). Log and let the next tick retry.
    console.warn("[eventBus] pine poll failed", err);
  } finally {
    ch.fetchInFlight = false;
  }
}

// ─── Internals: subscriber bootstrap ──────────────────────────────

async function bootstrapSubscriber(
  ch: Channel,
  sub: { opts: LogSubscriptionOpts; listener: Listener }
): Promise<void> {
  // Guard the channel for the duration of bootstrap. pollChannel
  // checks `ch.bootstrapped` AND `ch.fetchInFlight` and skips when
  // either gate is closed — so the live-tick driver can't race in
  // and emit before bootstrap has assembled the first batch.
  ch.fetchInFlight = true;
  try {
    const status = await waitForPineReady();
    const head = status.finalizedHead;
    const pineFloor = status.indexedFromBlock;
    const requestedFrom = Math.max(0, head - sub.opts.windowBlocks);

    // Case A: pine's window covers the entire request.
    if (requestedFrom >= pineFloor) {
      const logs = await pineGetLogsSafe(ch, requestedFrom, head);
      ch.logs.push(...logs);
      ch.earliestFetchedBlock = requestedFrom;
      ch.lastFetchedBlock = head;
      safeListener(sub, { logs, viaRpc: false });
      ch.bootstrapped = true;
      return;
    }

    // Case B: pine's window is short and the subscriber can't use
    // RPC. Truncate.
    if (!sub.opts.historyAllowed) {
      const logs = await pineGetLogsSafe(ch, pineFloor, head);
      ch.logs.push(...logs);
      ch.earliestFetchedBlock = pineFloor;
      ch.lastFetchedBlock = head;
      safeListener(sub, { logs, viaRpc: false, truncatedTo: pineFloor });
      ch.bootstrapped = true;
      return;
    }

    // Case C: operator route + history allowed. Splice RPC + pine.
    let rpcSlice: EthLog[] = [];
    try {
      rpcSlice = await rpcGetLogs(getRpcEndpoint(), ch, requestedFrom, pineFloor - 1);
    } catch (err) {
      console.warn("[eventBus] bootstrap rpc fetch failed", err);
    }
    const pineSlice = await pineGetLogsSafe(ch, pineFloor, head);
    const merged = mergeUnique([...rpcSlice, ...pineSlice]);
    ch.logs.push(...merged);
    ch.earliestFetchedBlock =
      rpcSlice.length > 0 ? requestedFrom : pineFloor;
    ch.lastFetchedBlock = head;
    safeListener(sub, { logs: merged, viaRpc: rpcSlice.length > 0 });
    ch.bootstrapped = true;
  } finally {
    ch.fetchInFlight = false;
  }
}

/// Call a subscriber's listener safely. A throwing listener doesn't
/// abort the bootstrap (or future emissions); we log and move on.
function safeListener(
  sub: { opts: LogSubscriptionOpts; listener: Listener },
  emission: LogEmission
): void {
  try {
    sub.listener(emission);
  } catch (err) {
    console.error("[eventBus] subscriber threw", err);
  }
}

async function pineGetLogsSafe(
  ch: Pick<Channel, "address" | "topic0" | "topic1" | "topic2" | "topic3">,
  fromBlock: number,
  toBlock: number
): Promise<EthLog[]> {
  try {
    return await pineGetLogs(ch, fromBlock, toBlock);
  } catch (err) {
    console.warn("[eventBus] bootstrap pine fetch failed", err);
    return [];
  }
}

async function waitForPineReady(): Promise<PineStatus> {
  return new Promise((resolve) => {
    const unsub = onPineStatus((s) => {
      if (s.state === "ready") {
        unsub();
        resolve(s);
      }
    });
  });
}

// ─── Internals: RPC + pine fetch helpers ───────────────────────────

async function pineGetLogs(
  ch: Pick<Channel, "address" | "topic0" | "topic1" | "topic2" | "topic3">,
  fromBlock: number,
  toBlock: number
): Promise<EthLog[]> {
  if (fromBlock > toBlock) return [];
  const result = await pineRpc<EthLog[]>("eth_getLogs", [
    {
      address: ch.address,
      topics: topicsArrayFor(ch),
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ]);
  return result ?? [];
}

async function rpcGetLogs(
  rpcUrl: string,
  ch: Pick<Channel, "address" | "topic0" | "topic1" | "topic2" | "topic3">,
  fromBlock: number,
  toBlock: number
): Promise<EthLog[]> {
  if (fromBlock > toBlock) return [];
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: ch.address,
          topics: topicsArrayFor(ch),
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
  const json = (await resp.json()) as { result?: EthLog[]; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "RPC error");
  return json.result ?? [];
}

/// Build the JSON-RPC `topics` array. eth_getLogs trims trailing nulls
/// but accepts null for "match any" at any position; we preserve nulls
/// in the middle (e.g. [topic0, null, userTopic]) so the indexed
/// filter binds to the right slot.
function topicsArrayFor(
  ch: Pick<Channel, "topic0" | "topic1" | "topic2" | "topic3">
): (string | null)[] {
  const out: (string | null)[] = [ch.topic0];
  let hasMore = ch.topic1 !== null || ch.topic2 !== null || ch.topic3 !== null;
  if (!hasMore) return out;
  out.push(ch.topic1);
  if (ch.topic2 === null && ch.topic3 === null) return out;
  out.push(ch.topic2);
  if (ch.topic3 === null) return out;
  out.push(ch.topic3);
  return out;
}

function channelKey(opts: LogSubscriptionOpts): string {
  const t1 = opts.topic1 ?? "*";
  const t2 = opts.topic2 ?? "*";
  const t3 = opts.topic3 ?? "*";
  return `${opts.address.toLowerCase()}:${opts.topic0.toLowerCase()}:${t1}:${t2}:${t3}`;
}

function mergeUnique(logs: EthLog[]): EthLog[] {
  // Logs are uniquely identified by (transactionHash, logIndex).
  // We may dedupe across pine + cached + rpc slices when ranges
  // overlap. Stable sort by blockNumber asc, logIndex asc.
  const seen = new Set<string>();
  const out: EthLog[] = [];
  for (const log of logs) {
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(log);
  }
  out.sort((a, b) => {
    const ab = Number(BigInt(a.blockNumber));
    const bb = Number(BigInt(b.blockNumber));
    if (ab !== bb) return ab - bb;
    return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
  });
  return out;
}

// ─── Test surface ──────────────────────────────────────────────────

export const __test = {
  reset(): void {
    _channels.clear();
    if (_statusUnsubscribe) {
      _statusUnsubscribe();
      _statusUnsubscribe = null;
    }
    _lastSeenHead = 0;
  },
  channelCount(): number {
    return _channels.size;
  },
  /// Force a head-tick — bypasses pine status subscription so tests
  /// can drive the bus deterministically.
  tickHead(head: number): Promise<void> {
    _lastSeenHead = head - 1;
    return onPineStatusTick({
      state: "ready",
      step: "connected",
      peers: 1,
      finalizedHead: head,
      indexedFromBlock: 0,
    });
  },
};
