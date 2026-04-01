// Paseo eth-rpc workaround: getTransactionReceipt returns null for confirmed txs.
// Instead of tx.wait(), we poll the sender's nonce until it advances past the
// nonce used by the transaction, confirming inclusion.

import { JsonRpcProvider } from "ethers";

/**
 * Wait for a transaction to be confirmed by polling the sender's nonce.
 * Works around the Paseo getTransactionReceipt bug.
 *
 * @param provider - JSON-RPC provider
 * @param senderAddress - Address that sent the transaction
 * @param preNonce - The sender's nonce BEFORE the transaction was sent
 * @param maxWaitSec - Maximum seconds to wait (default 120)
 */
export async function waitForNonce(
  provider: JsonRpcProvider,
  senderAddress: string,
  preNonce: number,
  maxWaitSec = 120,
): Promise<void> {
  for (let i = 0; i < maxWaitSec; i++) {
    const current = await provider.getTransactionCount(senderAddress);
    if (current > preNonce) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Transaction confirmation timeout (nonce did not advance).");
}

/**
 * Replacement for tx.wait() that works on Paseo.
 * Tries receipt first (15s timeout), falls back to nonce polling.
 *
 * Usage:
 *   const tx = await contract.someMethod(args);
 *   await waitForTx(provider, senderAddress, tx);
 */
export async function waitForTx(
  provider: JsonRpcProvider,
  senderAddress: string,
  tx: { hash: string; wait?: (confirms?: number) => Promise<any>; nonce?: number },
  maxWaitSec = 120,
): Promise<void> {
  // Try tx.wait() first with a timeout — works on non-Paseo chains
  if (tx.wait) {
    try {
      const result = await Promise.race([
        tx.wait(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error("receipt-timeout")), 15_000)),
      ]);
      if (result) return;
    } catch (e: any) {
      // If it's a receipt timeout, fall through to nonce polling
      if (e?.message !== "receipt-timeout") throw e;
    }
  }

  // Paseo fallback: nonce polling
  // Derive pre-nonce from tx.nonce if available, otherwise poll current - 1
  const preNonce = tx.nonce ?? (await provider.getTransactionCount(senderAddress)) - 1;
  await waitForNonce(provider, senderAddress, preNonce, maxWaitSec);
}
