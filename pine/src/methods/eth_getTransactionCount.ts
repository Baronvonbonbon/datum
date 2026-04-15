import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { encodeH160, decodeU256 } from "../codec/scale.js";
import { toHex } from "../codec/denomination.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const address = params[0] as string;

      const cacheKey = `nonce:${address.toLowerCase()}`;
      const cached = ctx.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;

      // Call ReviveApi_nonce(address: H160) → U256
      const encodedAddr = encodeH160(address);
      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_nonce",
        encodedAddr,
      );

      const nonce = decodeU256(resultBytes);
      const hex = toHex(nonce);

      ctx.cache.set(cacheKey, hex, ctx.config.cache?.stateTtlMs);
      return hex;
    },
  };
}

registerMethod("eth_getTransactionCount", factory);
