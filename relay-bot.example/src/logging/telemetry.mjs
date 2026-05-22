// Telemetry — a ring buffer of recent events + per-counter
// metrics. Read by the /metrics + /events HTTP endpoints (Stage
// 7c) and surfaced to the /publisher dashboard.
//
// The buffer is bounded so the relay can run unattended without
// unbounded memory growth.

const MAX_EVENTS = 1000;

const state = {
  startedAt: Date.now(),
  events: [], // newest first; len ≤ MAX_EVENTS
  counters: {
    clicksReceived: 0,
    clicksSubmitted: 0,
    clickErrors: 0,
    claimsReceived: 0,
    claimsSubmitted: 0,
    claimErrors: 0,
    stakeRootsPosted: 0,
    stakeRootErrors: 0,
    identityCallbacks: 0,
    pineErrors: 0,
  },
  lastTxs: [], // newest first; len ≤ 10
  pine: {
    connected: false,
    finalizedBlock: 0,
    peers: 0,
  },
  signer: {
    address: "",
    balance: "0",
  },
  lastStakeRootEpoch: null,
};

export function recordEvent(type, payload) {
  const ev = { ts: Date.now(), type, ...payload };
  state.events.unshift(ev);
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

export function bumpCounter(name, n = 1) {
  if (state.counters[name] === undefined) state.counters[name] = 0;
  state.counters[name] += n;
}

export function recordTx(kind, hash, ok, extra) {
  state.lastTxs.unshift({ ts: Date.now(), kind, hash, ok, ...(extra ?? {}) });
  if (state.lastTxs.length > 10) state.lastTxs.length = 10;
}

export function setPineState(next) {
  Object.assign(state.pine, next);
}

export function setSigner(address, balance) {
  state.signer.address = address;
  state.signer.balance = String(balance);
}

export function setLastStakeRootEpoch(epoch) {
  state.lastStakeRootEpoch = epoch;
}

export function snapshot() {
  return {
    startedAt: state.startedAt,
    uptimeMs: Date.now() - state.startedAt,
    counters: { ...state.counters },
    lastTxs: [...state.lastTxs],
    pine: { ...state.pine },
    signer: { ...state.signer },
    lastStakeRootEpoch: state.lastStakeRootEpoch,
  };
}

export function eventsSince(blockOrTs) {
  // `since=<n>` accepts either a block number (small) or a ms
  // timestamp (large). Anything ≥ 10^11 is a timestamp; anything
  // smaller is a block number — and events keyed by block carry
  // their own .block field set by the recorder.
  const n = Number(blockOrTs);
  if (!Number.isFinite(n) || n <= 0) return state.events.slice();
  if (n >= 1e11) return state.events.filter((e) => e.ts >= n);
  return state.events.filter((e) => (e.block ?? 0) >= n);
}
