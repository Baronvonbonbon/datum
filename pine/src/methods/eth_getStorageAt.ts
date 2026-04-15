import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import { encodeH160, encodeH256, concatBytes, bytesToHex } from "../codec/scale.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const address = params[0] as string;
      const position = params[1] as string;

      const cacheKey = `storage:${address.toLowerCase()}:${position}`;
      const cached = ctx.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;

      // Call ReviveApi_get_storage(address: H160, key: H256) → Option<Vec<u8>>
      const encoded = concatBytes(encodeH160(address), encodeH256(position));
      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_get_storage",
        encoded,
      );

      let value: string;
      if (resultBytes.length === 0 || resultBytes[0] === 0) {
        // None or empty — return zero-padded 32 bytes
        value = "0x" + "0".repeat(64);
      } else {
        // Some(bytes) — return raw 32 bytes
        value = "0x" + bytesToHex(resultBytes.slice(1)).padStart(64, "0");
      }

      ctx.cache.set(cacheKey, value, ctx.config.cache?.stateTtlMs);
      return value;
    },
  };
}

registerMethod("eth_getStorageAt", factory);
