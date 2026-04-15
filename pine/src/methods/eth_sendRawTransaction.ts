import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { buildEthTransactExtrinsic } from "../codec/extrinsic.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const rawTx = params[0] as string;

      // Compute tx hash (keccak256 of raw bytes)
      const { keccak256, Transaction } = await import("ethers");
      const txHash = keccak256(rawTx);

      // Decode the raw tx to extract sender info for TxPool tracking
      if (ctx.txPool) {
        try {
          const decoded = Transaction.from(rawTx);
          ctx.txPool.addPending({
            hash: txHash,
            raw: rawTx,
            from: decoded.from ?? "0x" + "0".repeat(40),
            to: decoded.to ?? null,
            nonce: decoded.nonce,
            value: "0x" + (decoded.value ?? 0n).toString(16),
            data: decoded.data ?? "0x",
            submittedAt: Date.now(),
          });
        } catch {
          // Can't decode — still submit, just won't be tracked
        }
      }

      // Wrap the raw Ethereum tx in a Revive.eth_transact unsigned extrinsic
      const extrinsic = buildEthTransactExtrinsic(rawTx, ctx.config.extrinsic);

      // Submit via transaction_v1_broadcast
      await ctx.chainManager.submitTransaction(extrinsic);

      return txHash;
    },
  };
}

registerMethod("eth_sendRawTransaction", factory);
