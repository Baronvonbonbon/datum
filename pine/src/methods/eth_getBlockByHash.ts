import type { MethodContext, MethodHandler, EthBlock } from "../types.js";
import { registerMethod } from "./registry.js";
import { formatEthBlock } from "../codec/block.js";
import { ChainManager } from "../transport/ChainManager.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<EthBlock | null> {
      const hash = params[0] as string;
      const _fullTx = params[1] as boolean ?? false;

      const cm = ctx.chainManager as ChainManager;
      const tracked = cm.getTrackedBlock(hash);
      if (tracked) {
        return formatEthBlock(tracked);
      }

      // Not in our tracked window
      return null;
    },
  };
}

registerMethod("eth_getBlockByHash", factory);
