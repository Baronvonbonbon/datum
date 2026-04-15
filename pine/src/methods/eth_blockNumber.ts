import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { toHex } from "../codec/denomination.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(_params: unknown[]): Promise<string> {
      return toHex(BigInt(ctx.chainManager.getBlockNumber()));
    },
  };
}

registerMethod("eth_blockNumber", factory);
