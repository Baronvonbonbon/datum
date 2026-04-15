import type { MethodContext, MethodHandler, EthBlock } from "../types.js";
import { registerMethod } from "./registry.js";
import { formatEthBlock, pendingBlock } from "../codec/block.js";
import { toBigInt } from "../codec/denomination.js";
import { ChainManager } from "../transport/ChainManager.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<EthBlock | null> {
      const blockTag = params[0] as string;
      const _fullTx = params[1] as boolean ?? false;

      if (blockTag === "pending") return pendingBlock();

      let blockNum: number;
      if (blockTag === "latest" || blockTag === "finalized" || blockTag === "safe") {
        blockNum = ctx.chainManager.getBlockNumber();
      } else if (blockTag === "earliest") {
        blockNum = 0;
      } else {
        blockNum = Number(toBigInt(blockTag));
      }

      // Check tracked blocks
      const cm = ctx.chainManager as ChainManager;
      const tracked = cm.getTrackedBlockByNumber(blockNum);
      if (tracked) {
        return formatEthBlock(tracked);
      }

      // Block not in our window
      const hash = await ctx.chainManager.getBlockHashByNumber(blockNum);
      if (!hash) return null;

      const headerBytes = await ctx.chainManager.getHeader(hash);
      if (!headerBytes) return null;

      // We don't have a full TrackedBlock for historical blocks — return minimal
      return formatEthBlock({
        number: blockNum,
        hash,
        parentHash: "0x" + "0".repeat(64),
        stateRoot: "0x" + "0".repeat(64),
        extrinsicsRoot: "0x" + "0".repeat(64),
        timestamp: 0,
      });
    },
  };
}

registerMethod("eth_getBlockByNumber", factory);
