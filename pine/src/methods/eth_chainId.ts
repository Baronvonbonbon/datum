import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";

// Chain IDs for known Asset Hub networks
const CHAIN_IDS: Record<string, number> = {
  "paseo-asset-hub": 420420417,
  "polkadot-asset-hub": 420420416,
  "kusama-asset-hub": 420420418,
  "westend-asset-hub": 420420419,
};

function factory(ctx: MethodContext): MethodHandler {
  const chainId = CHAIN_IDS[ctx.config.chain] ?? 420420417;
  const hex = "0x" + chainId.toString(16);

  return {
    async execute(_params: unknown[]): Promise<string> {
      return hex;
    },
  };
}

registerMethod("eth_chainId", factory);
