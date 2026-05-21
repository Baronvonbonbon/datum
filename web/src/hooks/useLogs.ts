// useLogs — React hook around eventBus.
//
// Returns an accumulating log buffer plus status flags. Subscribers
// re-render on every emission. The hook handles:
//
//   - Subscribing on mount, unsubscribing on unmount.
//   - Accumulating multi-batch emissions into a single sorted array
//     (bootstrap + per-block adds).
//   - Tracking viaRpc / truncatedTo so the consumer can render
//     "via RPC" badges + "partial window" banners.
//
// Operator routes must set `historyAllowed: true` explicitly. The
// type system enforces that the flag is a boolean — the runtime
// gate lives in eventBus / queryWithFallback (Stage 3a).

import { useEffect, useState } from "react";
import {
  subscribeLogs,
  type EthLog,
  type LogSubscriptionOpts,
} from "../lib/eventBus";

export type UseLogsResult = {
  /// All logs received so far, sorted by (blockNumber, logIndex) asc.
  logs: EthLog[];
  /// True once the bootstrap emission has arrived. Components use
  /// this to swap from a loading placeholder to the real content.
  ready: boolean;
  /// True iff the RPC fallback contributed at least one log batch.
  /// Sticky for the lifetime of the hook so the badge doesn't flicker
  /// off after the first live emission (which is pine-only).
  viaRpc: boolean;
  /// When defined, history is missing before this block. The hook
  /// sets this only on the bootstrap emission; later live emissions
  /// don't clear it.
  truncatedTo?: number;
};

export function useLogs(opts: LogSubscriptionOpts): UseLogsResult {
  const [result, setResult] = useState<UseLogsResult>(() => ({
    logs: [],
    ready: false,
    viaRpc: false,
    truncatedTo: undefined,
  }));

  useEffect(() => {
    // Reset state when the subscription opts change. React's
    // dependency array on the useEffect treats the whole opts object
    // by identity — callers should memoize for stable subscriptions,
    // but resetting here keeps the UI consistent if they don't.
    setResult({ logs: [], ready: false, viaRpc: false, truncatedTo: undefined });

    let cancelled = false;
    const unsub = subscribeLogs(opts, (emission) => {
      if (cancelled) return;
      setResult((prev) => {
        // Merge the new batch with the prior set, dedup by
        // (txHash, logIndex). We keep the eventBus's natural order
        // since it already sorts on each emission.
        const seen = new Set<string>();
        const all: EthLog[] = [];
        for (const log of [...prev.logs, ...emission.logs]) {
          const id = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(log);
        }
        all.sort((a, b) => {
          const ab = Number(BigInt(a.blockNumber));
          const bb = Number(BigInt(b.blockNumber));
          if (ab !== bb) return ab - bb;
          return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
        });
        return {
          logs: all,
          ready: true,
          // Sticky once true.
          viaRpc: prev.viaRpc || emission.viaRpc,
          // Set only on the first emission; preserve thereafter.
          truncatedTo: prev.ready ? prev.truncatedTo : emission.truncatedTo,
        };
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // We depend on the structural fields so callers don't need to
    // memoize the opts object — most won't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.address, opts.topic0, opts.windowBlocks, opts.historyAllowed]);

  return result;
}
