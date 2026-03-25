// Behavior commitment — computes a single bytes32 commitment from a behavior chain.
// This commitment is stored alongside claims for future ZK proof generation.
// NOT included in on-chain claim hash (contract doesn't validate it yet).

import { keccak256, solidityPackedKeccak256 } from "ethers";
import { BehaviorChainState } from "@shared/types";

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

  return solidityPackedKeccak256(
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
