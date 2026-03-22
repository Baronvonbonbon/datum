// Polls DatumTimelock for ChangeProposed events and caches pending changes.
// Surfaces warnings in the popup UI so users can see upcoming admin changes.

import { JsonRpcProvider } from "ethers";
import { getTimelockContract } from "@shared/contracts";
import { ContractAddresses } from "@shared/types";

const STORAGE_KEY = "timelockPendingChanges";

export interface PendingTimelockChange {
  target: string;
  data: string;
  effectiveTime: number; // unix timestamp
  blockNumber: number;
}

export const timelockMonitor = {
  async poll(rpcUrl: string, addresses: ContractAddresses): Promise<void> {
    try {
      if (!addresses.timelock || !addresses.timelock.startsWith("0x")) {
        return;
      }

      const provider = new JsonRpcProvider(rpcUrl);
      const timelock = getTimelockContract(addresses, provider);

      // Query ChangeProposed events (last ~14400 blocks ≈ 24h on Polkadot Hub)
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 14400);

      const proposedFilter = timelock.filters.ChangeProposed();
      const executedFilter = timelock.filters.ChangeExecuted();
      const cancelledFilter = timelock.filters.ChangeCancelled();

      const [proposed, executed, cancelled] = await Promise.all([
        timelock.queryFilter(proposedFilter, fromBlock),
        timelock.queryFilter(executedFilter, fromBlock),
        timelock.queryFilter(cancelledFilter, fromBlock),
      ]);

      // Build set of targets that have been executed or cancelled
      const resolved = new Set<string>();
      for (const e of [...executed, ...cancelled]) {
        const target: string = (e as any).args?.[0] ?? "";
        if (target) resolved.add(target.toLowerCase());
      }

      // Filter proposed events to only those still pending
      const pending: PendingTimelockChange[] = [];
      for (const e of proposed) {
        const args = (e as any).args;
        const target: string = args?.[0] ?? args?.target ?? "";
        const data: string = args?.[1] ?? args?.data ?? "";
        const effectiveTime = Number(args?.[2] ?? args?.effectiveTime ?? 0);

        if (!resolved.has(target.toLowerCase())) {
          pending.push({
            target,
            data,
            effectiveTime,
            blockNumber: e.blockNumber,
          });
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: pending });
      if (pending.length > 0) {
        console.log(`[DATUM] Timelock: ${pending.length} pending change(s) detected`);
      }
    } catch (err) {
      console.warn("[DATUM] timelockMonitor.poll failed:", err);
    }
  },

  async getPending(): Promise<PendingTimelockChange[]> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? [];
  },
};
