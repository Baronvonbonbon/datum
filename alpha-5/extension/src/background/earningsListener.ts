// Earnings listener — chrome.alarms-driven incremental scanner.
//
// MV3 service workers idle after ~30s, so live `provider.on()` subscriptions
// die silently. Instead we run a chunked eth_getLogs scan every minute via
// chrome.alarms, picking up where the last scan left off. The pure indexer
// in shared/earningsIndex.ts handles dedup and aggregation.

import { Provider } from "ethers";
import {
  earningsKey,
  emptyIndex,
  EarningsIndex,
  scanRange,
  DEFAULT_BACKFILL_BLOCKS,
} from "../shared/earningsIndex";
import { getProvider } from "../shared/contracts";
import { ContractAddresses } from "../shared/types";

export const EARNINGS_ALARM = "earnings:scan";
export const EARNINGS_PERIOD_MIN = 1; // chrome.alarms minimum is 1 minute

async function loadIndex(key: string): Promise<EarningsIndex> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as EarningsIndex | undefined) ?? emptyIndex();
}

async function saveIndex(key: string, index: EarningsIndex): Promise<void> {
  await chrome.storage.local.set({ [key]: index });
}

/**
 * Start (or refresh) the earnings indexer for `userAddress`.
 * Runs an immediate catch-up scan, then schedules a chrome.alarms-driven
 * periodic incremental scan that survives MV3 service-worker idle.
 *
 * Idempotent: re-calling replaces any prior alarm.
 */
export async function startEarningsListener(opts: {
  rpcUrl: string;
  chainId: number;
  contractAddresses: ContractAddresses;
  userAddress: string;
}): Promise<void> {
  const { rpcUrl, chainId, contractAddresses, userAddress } = opts;

  const provider = getProvider(rpcUrl);
  // Initial catch-up — incremental from lastScannedBlock or default window
  await catchUpEarnings({ provider, chainId, contractAddresses, userAddress });

  // Schedule the periodic alarm (will fire ~every minute and survive SW idle).
  await chrome.alarms.clear(EARNINGS_ALARM);
  await chrome.alarms.create(EARNINGS_ALARM, {
    delayInMinutes: EARNINGS_PERIOD_MIN,
    periodInMinutes: EARNINGS_PERIOD_MIN,
  });
}

/**
 * Stop the periodic scanner (e.g., on wallet disconnect).
 */
export async function stopEarningsListener(): Promise<void> {
  await chrome.alarms.clear(EARNINGS_ALARM);
}

/**
 * Alarm handler. Looks up the currently connected wallet from storage,
 * resolves the chainId from the active network, and runs an incremental
 * catch-up scan. No-op if the wallet was disconnected.
 */
export async function handleEarningsAlarm(opts: {
  rpcUrl: string;
  chainId: number;
  contractAddresses: ContractAddresses;
}): Promise<void> {
  const stored = await chrome.storage.local.get("connectedAddress");
  const userAddress: string | undefined = stored.connectedAddress;
  if (!userAddress) return;
  if (!opts.contractAddresses.settlement) return;
  try {
    const provider = getProvider(opts.rpcUrl);
    await catchUpEarnings({
      provider,
      chainId: opts.chainId,
      contractAddresses: opts.contractAddresses,
      userAddress,
    });
  } catch (err) {
    console.warn("[earnings] periodic scan failed:", err);
  }
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
