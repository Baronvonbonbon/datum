// WS-5: Bounded event log fetching utility.
// Prevents unbounded queryFilter calls that could fetch millions of logs
// and hit RPC gas/response limits on public nodes.
//
// Default: last 10,000 blocks (~16.7 hours at 6s/block on Polkadot Hub).

import { Contract } from "ethers";

/** Maximum block range for event queries (prevents RPC overload). */
const DEFAULT_MAX_BLOCKS = 10_000;

/**
 * Query contract events with a bounded block range.
 * Falls back gracefully if the RPC rejects the range.
 */
export async function queryFilterBounded(
  contract: Contract,
  filter: any,
  maxBlocks: number = DEFAULT_MAX_BLOCKS,
): Promise<any[]> {
  try {
    return await contract.queryFilter(filter, -maxBlocks);
  } catch {
    // Some RPCs don't support negative block offsets — try without range
    // but catch oversized responses
    try {
      return await contract.queryFilter(filter);
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
  try {
    return await contract.queryFilter(filter, 0, "latest");
  } catch {
    // Fallback: try unbounded (some RPCs handle this better)
    try {
      return await contract.queryFilter(filter);
    } catch {
      // Last resort: bounded recent range
      return queryFilterBounded(contract, filter);
    }
  }
}
