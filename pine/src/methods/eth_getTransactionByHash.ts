import type { MethodContext, MethodHandler, EthTransaction } from "../types.js";
import { registerMethod } from "./registry.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<EthTransaction | null> {
      const txHash = params[0] as string;

      if (!ctx.txPool) {
        return null;
      }

      return ctx.txPool.formatTransaction(txHash);
    },
  };
}

registerMethod("eth_getTransactionByHash", factory);
