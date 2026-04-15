import type { MethodContext, MethodHandler, EthTransactionReceipt } from "../types.js";
import { registerMethod } from "./registry.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<EthTransactionReceipt | null> {
      const txHash = params[0] as string;

      if (!ctx.receiptBuilder) {
        return null;
      }

      return ctx.receiptBuilder.getReceipt(txHash);
    },
  };
}

registerMethod("eth_getTransactionReceipt", factory);
