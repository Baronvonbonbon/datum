// Earnings listener — chrome.storage adapter around the pure earningsIndex
// module. Subscribes to ClaimSettled live, runs an initial Pine-friendly
// backfill (~3.5 days at 6s blocks), and incrementally catches up after
// extension restarts or wallet switches.

import { Contract, JsonRpcProvider, Provider } from "ethers";
import {
  applyEvent,
  decodeClaimSettled,
  earningsKey,
  emptyIndex,
  EarningsIndex,
  scanRange,
  DEFAULT_BACKFILL_BLOCKS,
} from "../shared/earningsIndex";
import { getSettlementContract, getProvider } from "../shared/contracts";
import { ContractAddresses } from "../shared/types";

const liveSubscriptions = new Map<string, () => void>();

async function loadIndex(key: string): Promise<EarningsIndex> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as EarningsIndex | undefined) ?? emptyIndex();
}

async function saveIndex(key: string, index: EarningsIndex): Promise<void> {
  await chrome.storage.local.set({ [key]: index });
}

/**
 * Start (or refresh) the live ClaimSettled subscription for `userAddress`.
 * Idempotent on (chainId, userAddress); replaces any prior subscription.
 */
export async function startEarningsListener(opts: {
  rpcUrl: string;
  chainId: number;
  contractAddresses: ContractAddresses;
  userAddress: string;
}): Promise<void> {
  const { rpcUrl, chainId, contractAddresses, userAddress } = opts;
  const key = earningsKey(chainId, userAddress);

  // Tear down any existing subscription for this account
  liveSubscriptions.get(key)?.();
  liveSubscriptions.delete(key);

  const provider = getProvider(rpcUrl);

  // Initial backfill (or incremental catch-up) before wiring the live listener.
  await catchUpEarnings({ provider, chainId, contractAddresses, userAddress });

  // Wire the live listener
  const settlement = getSettlementContract(contractAddresses, provider);
  const userTopic = "0x" + userAddress.slice(2).toLowerCase().padStart(64, "0");
  const claimSettledTopic = settlement.getEvent("ClaimSettled").fragment.topicHash;

  const filter = {
    address: settlement.target as string,
    topics: [claimSettledTopic, null, userTopic],
  };

  const handler = async (log: any) => {
    try {
      const decoded = decodeClaimSettled(log, settlement.interface);
      if (!decoded) return;
      let blockTimestamp: number | undefined = undefined;
      try {
        const block = await provider.getBlock(decoded.blockNumber);
        if (block?.timestamp) blockTimestamp = Number(block.timestamp);
      } catch { /* timestamp best-effort */ }
      const index = await loadIndex(key);
      const { applied } = applyEvent(index, { ...decoded, blockTimestamp });
      if (applied) await saveIndex(key, index);
    } catch (err) {
      console.warn("[earnings] live handler error:", err);
    }
  };

  await provider.on(filter, handler);

  // Save the unsubscribe handle
  liveSubscriptions.set(key, () => {
    provider.off(filter, handler).catch(() => { /* shutdown */ });
    if (provider instanceof JsonRpcProvider) {
      try { provider.destroy(); } catch { /* shutdown */ }
    }
  });
}

/**
 * Stop the live listener for an account (e.g., on wallet switch).
 */
export function stopEarningsListener(chainId: number, userAddress: string): void {
  const key = earningsKey(chainId, userAddress);
  liveSubscriptions.get(key)?.();
  liveSubscriptions.delete(key);
}

/**
 * Run a one-shot backfill from the user's `lastScannedBlock` (or
 * latestBlock - DEFAULT_BACKFILL_BLOCKS on first run) to the current head.
 * Pine-friendly chunked scan; safe to call repeatedly.
 */
export async function catchUpEarnings(opts: {
  provider: Provider;
  chainId: number;
  contractAddresses: ContractAddresses;
  userAddress: string;
  windowBlocks?: number;             // override default backfill window (first run only)
  onProgress?: (scanned: number, total: number) => void;
}): Promise<{ applied: number; fromBlock: number; toBlock: number }> {
  const { provider, chainId, contractAddresses, userAddress } = opts;
  const key = earningsKey(chainId, userAddress);
  const index = await loadIndex(key);

  const head = await provider.getBlockNumber();
  const window = opts.windowBlocks ?? DEFAULT_BACKFILL_BLOCKS;

  // Resume from lastScannedBlock + 1 (incremental) or head - window (initial).
  const fromBlock =
    index.lastScannedBlock > 0
      ? Math.min(index.lastScannedBlock + 1, head)
      : Math.max(0, head - window);
  const toBlock = head;

  if (fromBlock > toBlock) return { applied: 0, fromBlock, toBlock };

  const applied = await scanRange({
    provider,
    settlementAddress: contractAddresses.settlement,
    user: userAddress,
    fromBlock,
    toBlock,
    index,
    enrichTimestamp: true,
    onProgress: opts.onProgress,
  });
  await saveIndex(key, index);

  return { applied, fromBlock, toBlock };
}
