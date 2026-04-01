// Hook that provides a waitForTx function using the current RPC provider.
// Wraps the Paseo nonce-polling workaround so pages just call:
//   const tx = await contract.someMethod(args);
//   await confirmTx(tx);

import { useCallback } from "react";
import { JsonRpcProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
import { waitForTx } from "@shared/waitForTx";

/**
 * Returns a `confirmTx(tx)` function that confirms a transaction
 * using nonce polling on Paseo (falls back to tx.wait() on other chains).
 */
export function useTx() {
  const { settings } = useSettings();
  const { address } = useWallet();

  const confirmTx = useCallback(async (
    tx: { hash: string; wait?: (confirms?: number) => Promise<any>; nonce?: number },
  ) => {
    if (!settings.rpcUrl || !address) {
      // No provider info — fall back to tx.wait()
      await tx.wait?.(1);
      return;
    }
    const provider = new JsonRpcProvider(settings.rpcUrl);
    await waitForTx(provider, address, tx);
  }, [settings.rpcUrl, address]);

  return { confirmTx };
}
