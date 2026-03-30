// Behavior commitment — computes a single bytes32 commitment from a behavior chain.
// This commitment is stored alongside claims for future ZK proof generation.
// Alpha-2: Uses Blake2-256 to match on-chain hash semantics.
// NOT included in on-chain claim hash (contract doesn't validate it yet).

import { solidityPacked } from "ethers";
import { blake2b } from "@noble/hashes/blake2.js";
import { BehaviorChainState } from "@shared/types";

function blake2Hash(types: string[], values: unknown[]): string {
  const packed = solidityPacked(types, values);
  const h = packed.startsWith("0x") ? packed.slice(2) : packed;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const hash = blake2b(bytes, { dkLen: 32 });
  return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute a commitment hash from behavior chain state.
 * Encodes aggregate engagement metrics into a single bytes32.
 */
export function computeBehaviorCommit(chain: BehaviorChainState): string {
  const avgDwell = chain.eventCount > 0
    ? Math.round(chain.cumulativeDwellMs / chain.eventCount)
    : 0;
  const avgViewable = chain.eventCount > 0
    ? Math.round(chain.cumulativeViewableMs / chain.eventCount)
    : 0;
  const viewabilityRate = chain.eventCount > 0
    ? Math.round((chain.iabViewableCount * 10000) / chain.eventCount) // BPS
    : 0;

  return blake2Hash(
    ["bytes32", "uint256", "uint256", "uint256", "uint256", "string"],
    [
      chain.headHash,
      chain.eventCount,
      avgDwell,
      avgViewable,
      viewabilityRate,
      chain.campaignId,
    ],
  );
}
