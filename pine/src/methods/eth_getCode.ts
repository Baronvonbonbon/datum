import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { encodeH160, bytesToHex, decodeCompact } from "../codec/scale.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const address = params[0] as string;

      const cacheKey = `code:${address.toLowerCase()}`;
      const cached = ctx.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;

      // Call ReviveApi_get_code(address: H160) → Option<Vec<u8>>
      const encodedAddr = encodeH160(address);
      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_get_code",
        encodedAddr,
      );

      let code: string;
      if (resultBytes.length === 0) {
        code = "0x";
      } else if (resultBytes[0] === 0) {
        // Option::None
        code = "0x";
      } else {
        // Option::Some(Vec<u8>) — skip Option tag (1 byte) + decode compact-prefixed vec
        const [_len, compactSize] = decodeCompact(resultBytes, 1);
        code = "0x" + bytesToHex(resultBytes.slice(1 + compactSize));
      }

      // Cache code for longer — it rarely changes
      ctx.cache.set(cacheKey, code, ctx.config.cache?.codeTtlMs ?? 300_000);
      return code;
    },
  };
}

registerMethod("eth_getCode", factory);
