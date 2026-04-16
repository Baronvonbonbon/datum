// Hook that provides a waitForTx function using the current RPC provider.
// Wraps the Paseo nonce-polling workaround so pages just call:
//   const tx = await contract.someMethod(args);
//   await confirmTx(tx);

import { useCallback } from "react";
import type { JsonRpcApiProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
import { useContracts } from "./useContracts";
import { waitForTx } from "@shared/waitForTx";

/**
 * Returns a `confirmTx(tx)` function that confirms a transaction
 * using nonce polling on Paseo (falls back to tx.wait() on other chains).
 * Uses the Pine-aware readProvider when Pine is active.
 */
export function useTx() {
  const { settings } = useSettings();
  const { address } = useWallet();
  const { readProvider } = useContracts();

  const confirmTx = useCallback(async (
    tx: { hash: string; wait?: (confirms?: number) => Promise<any>; nonce?: number },
  ) => {
    if (!address) {
      await tx.wait?.(1);
      return;
    }
    const provider = readProvider as JsonRpcApiProvider;
    if (!provider) {
      await tx.wait?.(1);
      return;
    }
    await waitForTx(provider, address, tx);
  }, [readProvider, address]);

  return { confirmTx };
}
