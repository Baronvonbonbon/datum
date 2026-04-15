import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { encodeH160, decodeU256 } from "../codec/scale.js";
import { planckToWei, toHex } from "../codec/denomination.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const address = params[0] as string;
      // blockTag = params[1] — ignored for now, always latest finalized

      const cacheKey = `balance:${address.toLowerCase()}`;
      const cached = ctx.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;

      // Call ReviveApi_balance(address: H160) → U256 (planck)
      const encodedAddr = encodeH160(address);
      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_balance",
        encodedAddr,
      );

      const planck = decodeU256(resultBytes);
      const wei = planckToWei(planck);
      const hex = toHex(wei);

      ctx.cache.set(cacheKey, hex, ctx.config.cache?.stateTtlMs);
      return hex;
    },
  };
}

registerMethod("eth_getBalance", factory);
