import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";

const CHAIN_IDS: Record<string, string> = {
  "paseo-asset-hub": "420420417",
  "polkadot-asset-hub": "420420416",
  "kusama-asset-hub": "420420418",
  "westend-asset-hub": "420420419",
};

function factory(ctx: MethodContext): MethodHandler {
  const version = CHAIN_IDS[ctx.config.chain] ?? "420420417";

  return {
    async execute(_params: unknown[]): Promise<string> {
      return version;
    },
  };
}

registerMethod("net_version", factory);
