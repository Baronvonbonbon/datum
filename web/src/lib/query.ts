// queryWithFallback — the per-query routing primitive.
//
// Design doc §1 (r3): pine is the canonical chain access path. End-
// user tiles always get pine-only results, truncated to whatever
// pine has indexed since connect. Operator tiles can opt in to
// `historyAllowed: true` and we splice in older history from a
// configurable RPC endpoint when pine's window doesn't reach.
//
// This module is the single chokepoint where that policy is
// enforced. Hooks must not bypass it for log fetches — the type
// system + a runtime guard in `useLogs` (Stage 3b) keep the
// permission boundary honest.
//
// Shape of a query:
//   pine: () => Promise<T>           // mandatory — always tried first
//   rpcFallback?: () => Promise<T>   // optional — operator-only
//   windowBlocks: number             // requested log window size
//   historyAllowed: boolean          // true ⇒ allowed to splice RPC
//
// Result envelope:
//   { ok: true, data, viaRpc, truncatedTo? }
//   - viaRpc=true: the data includes a slice fetched from RPC
//   - truncatedTo=N: pine couldn't reach `windowBlocks` and no RPC
//     fallback was permitted/available; data starts at block N
//
// Errors bubble through as exceptions — pine reachability problems
// are surfaced via `getPineStatus()`, not via this primitive.

import { getPineProvider, getPineStatus } from "./provider";

export type QueryResult<T> = {
  /// The result of the underlying query.
  data: T;
  /// True iff the RPC fallback was used for at least some of the
  /// returned data. Tiles tag a "via RPC" badge when this is true.
  viaRpc: boolean;
  /// When defined, the result is missing history before block N.
  /// Tiles render a "Partial window — pine connected N min ago"
  /// banner so the user knows the gap is data, not visualization.
  truncatedTo?: number;
};

export type QueryRequest<T> = {
  /// Pine-backed query. Must always be provided. Receives the
  /// effective `fromBlock` we want data from (clamped to pine's
  /// indexedFromBlock) and `toBlock` (always currentBlock).
  pine: (fromBlock: number, toBlock: number) => Promise<T>;
  /// Optional RPC-backed query for the slice older than pine can
  /// serve. Receives `fromBlock` and `toBlock` (the latter is one
  /// less than pine's indexedFromBlock — no overlap with pine).
  /// Returns the same `T` shape; the caller is responsible for
  /// merging the two arrays.
  rpcFallback?: (fromBlock: number, toBlock: number) => Promise<T>;
  /// How merging works: caller supplies a `merge(rpcSlice, pineSlice)`
  /// function that returns the combined `T`. We don't assume `T` is
  /// an array; it could be a struct, a map, etc.
  merge?: (older: T, newer: T) => T;
  /// Requested log window in blocks. Used to compute the desired
  /// fromBlock as `currentBlock - windowBlocks`.
  windowBlocks: number;
  /// True iff this query is on an operator route (per isOperatorRoute).
  /// When false, rpcFallback is ignored even if provided — caller
  /// can't bypass the policy.
  historyAllowed: boolean;
};

/// Execute the query under the routing policy. The returned envelope
/// tags whether RPC was consulted and how far back the data goes.
export async function queryWithFallback<T>(
  q: QueryRequest<T>
): Promise<QueryResult<T>> {
  const status = getPineStatus();
  if (status.state !== "ready") {
    // The hooks layer waits on `onPineStatus` before calling us; if
    // we hit this branch the caller mis-wired. Surface a clean
    // error so misuse is obvious during dev rather than silently
    // returning empty data.
    throw new Error(`pine not ready (state=${status.state})`);
  }

  const currentBlock = status.finalizedHead;
  const requestedFrom = Math.max(0, currentBlock - q.windowBlocks);
  const pineFloor = status.indexedFromBlock;

  // Case A: pine's window already covers the request. No RPC even
  // if allowed.
  if (requestedFrom >= pineFloor) {
    const data = await q.pine(requestedFrom, currentBlock);
    return { data, viaRpc: false };
  }

  // Case B: pine's window is short. End-user route — truncate.
  if (!q.historyAllowed) {
    const data = await q.pine(pineFloor, currentBlock);
    return { data, viaRpc: false, truncatedTo: pineFloor };
  }

  // Case C: operator route with an rpcFallback. Splice.
  if (q.rpcFallback && q.merge) {
    const [older, newer] = await Promise.all([
      q.rpcFallback(requestedFrom, pineFloor - 1),
      q.pine(pineFloor, currentBlock),
    ]);
    const data = q.merge(older, newer);
    return { data, viaRpc: true };
  }

  // Case D: historyAllowed but no rpcFallback supplied — fall back
  // to truncation so the tile still renders. The caller would
  // normally supply rpcFallback when historyAllowed; this is a
  // defensive branch.
  const data = await q.pine(pineFloor, currentBlock);
  return { data, viaRpc: false, truncatedTo: pineFloor };
}

/// Convenience for the common "I just want pine, no fallback" tile.
/// Equivalent to queryWithFallback with historyAllowed=false but
/// reads cleaner at the call site:
///
///   const r = await queryPineOnly({ pine: ..., windowBlocks: 14_400 });
export function queryPineOnly<T>(args: {
  pine: (fromBlock: number, toBlock: number) => Promise<T>;
  windowBlocks: number;
}): Promise<QueryResult<T>> {
  return queryWithFallback({
    pine: args.pine,
    windowBlocks: args.windowBlocks,
    historyAllowed: false,
  });
}
