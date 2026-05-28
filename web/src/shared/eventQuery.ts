// WS-5: Bounded event log fetching utility.
// Prevents unbounded queryFilter calls that could fetch millions of logs
// and hit RPC gas/response limits on public nodes.
//
// Default: last 10,000 blocks (~16.7 hours at 6s/block on Polkadot Hub).
//
// Pine note: Pine's LogIndexer is forward-only — it only indexes blocks seen
// since smoldot connected. Any historical query against Pine returns 0 for
// events older than the connection. When Pine is the contract's provider and
// a fallback eth-rpc gateway URL has been registered (via setHistoricalLogFallback),
// queryFilter calls below reach through to the gateway for the actual log read
// while keeping state reads + sendRawTransaction on Pine.

import { Contract, JsonRpcProvider } from "ethers";

/** Maximum block range for event queries (prevents RPC overload). */
const DEFAULT_MAX_BLOCKS = 10_000;

let _historicalLogFallbackUrl: string | null = null;
const _historicalProviderCache = new Map<string, JsonRpcProvider>();

/**
 * Register a remote eth-rpc URL to use for historical log reads when the
 * contract's primary provider is Pine. Pine's forward-only LogIndexer can't
 * return logs from before smoldot connected, so dashboards see 0 events.
 * Set this once from the app shell (typically settings.rpcUrl).
 *
 * Pass `null` to clear (e.g., when Pine disconnects or the user opts out).
 */
export function setHistoricalLogFallback(url: string | null): void {
  _historicalLogFallbackUrl = url;
}

function isPineProvider(provider: unknown): boolean {
  return !!provider && (provider as { __isPine?: boolean }).__isPine === true;
}

/**
 * If the contract's provider is Pine and we have a fallback URL registered,
 * return a fresh Contract bound to the gateway provider so queryFilter hits a
 * full-history index. Otherwise return the original contract.
 */
function maybeWithFallbackProvider(contract: Contract): Contract {
  if (!_historicalLogFallbackUrl) return contract;
  const runner = contract.runner as { provider?: unknown } | null;
  const provider = runner?.provider ?? runner;
  if (!isPineProvider(provider)) return contract;
  let p = _historicalProviderCache.get(_historicalLogFallbackUrl);
  if (!p) {
    p = new JsonRpcProvider(_historicalLogFallbackUrl);
    _historicalProviderCache.set(_historicalLogFallbackUrl, p);
  }
  return contract.connect(p) as Contract;
}

/**
 * Query contract events with a bounded block range.
 * Falls back gracefully if the RPC rejects the range.
 */
export async function queryFilterBounded(
  contract: Contract,
  filter: any,
  maxBlocks: number = DEFAULT_MAX_BLOCKS,
): Promise<any[]> {
  const c = maybeWithFallbackProvider(contract);
  try {
    return await c.queryFilter(filter, -maxBlocks);
  } catch {
    // Some RPCs don't support negative block offsets — try without range
    // but catch oversized responses
    try {
      return await c.queryFilter(filter);
    } catch {
      return [];
    }
  }
}

/**
 * Query contract events from genesis (block 0).
 * Use for indexed queries that must find all historical events (e.g. "my campaigns").
 * Falls back to bounded query if full-range fails.
 */
export async function queryFilterAll(
  contract: Contract,
  filter: any,
): Promise<any[]> {
  const c = maybeWithFallbackProvider(contract);
  try {
    return await c.queryFilter(filter, 0, "latest");
  } catch {
    // Fallback: try unbounded (some RPCs handle this better)
    try {
      return await c.queryFilter(filter);
    } catch {
      // Last resort: bounded recent range
      return queryFilterBounded(c, filter);
    }
  }
}
