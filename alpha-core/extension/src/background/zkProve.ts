// zkProve — the snarkjs-backed ZK prover wired into claimBuilder on the service
// worker side. Kept in its own module so claimBuilder.ts stays free of the
// `./zkProof` (snarkjs) and `./poseidon` (circomlib) imports; the demo daemon
// imports claimBuilder without ever pulling these in. See claimBuilder.ts
// setProveZk()/ProveZkFn for the injection seam.

import type { ProveZkArgs } from "./claimBuilder";
import { generateZKProof } from "./zkProof";
import { getUserSecret, computeWindowId } from "./poseidon";

const WINDOW_BLOCKS = 14400; // 24h at 6s/block
const LAST_BLOCK_KEY = "pollLastBlock";

/** Real Groth16 prover: resolves the user secret + window from storage, then
 *  produces the proof array + nullifier for a ZK-required campaign claim. */
export async function proveZk(args: ProveZkArgs): Promise<{ proofArray: string[]; nullifier: string }> {
  const userSecret = await getUserSecret();
  const blockStored = await chrome.storage.local.get(LAST_BLOCK_KEY);
  const lastBlock: number = blockStored[LAST_BLOCK_KEY] ?? 0;
  const windowId = computeWindowId(lastBlock, WINDOW_BLOCKS);
  return generateZKProof(args.claimHash, args.eventCount, args.nonce, userSecret, args.campaignId, windowId);
}
