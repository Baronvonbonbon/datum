import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { toHex } from "../codec/denomination.js";
import { ChainManager } from "../transport/ChainManager.js";

// eth_getBlockTransactionCountByHash
function byHashFactory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string | null> {
      const hash = params[0] as string;
      try {
        const body = await ctx.chainManager.getBody(hash);
        return toHex(BigInt(body.length));
      } catch {
        return null;
      }
    },
  };
}

// eth_getBlockTransactionCountByNumber
function byNumberFactory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string | null> {
      const blockTag = params[0] as string;
      const cm = ctx.chainManager as ChainManager;

      let hash: string | null;
      if (blockTag === "latest" || blockTag === "finalized" || blockTag === "safe") {
        hash = cm.getBlockHash();
      } else {
        const num = Number(BigInt(blockTag));
        hash = await cm.getBlockHashByNumber(num);
      }

      if (!hash) return null;

      try {
        const body = await ctx.chainManager.getBody(hash);
        return toHex(BigInt(body.length));
      } catch {
        return null;
      }
    },
  };
}

registerMethod("eth_getBlockTransactionCountByHash", byHashFactory);
registerMethod("eth_getBlockTransactionCountByNumber", byNumberFactory);
