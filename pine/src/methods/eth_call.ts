// ── eth_call → ReviveApi_call ──
//
// This is the most important method — all contract reads go through here.
//
// Signature (from the Paseo Asset Hub runtime metadata, reviveApi.call):
//   origin: AccountId32           — the eth address mapped via h160 ++ 0xEE×12
//   dest: H160
//   value: u128                   — planck (NOT U256)
//   gas_limit: Option<Weight>
//   storage_deposit_limit: Option<u128>
//   input_data: Bytes             — LAST arg, after the two Options
//   → PalletRevivePrimitivesContractResultExecReturnValue
//
// All three of those were wrong in the original implementation (H160 origin,
// U256 value, input mis-ordered before the Options), which made the runtime
// reject the call and the result undecodable — surfacing as ethers BAD_DATA
// (`value="0x"`). The exact layouts below were captured from a live
// reviveApi.call round-trip (see test/eth_call-decode.test.mjs fixtures).

import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import {
  encodeH160,
  encodeReviveOrigin,
  encodeU128,
  encodeBytes,
  concatBytes,
  bytesToHex,
  hexToBytes,
  decodeCompact,
} from "../codec/scale.js";
import { weiToPlanck, toBigInt } from "../codec/denomination.js";

interface CallParams {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
}

const ZERO_ADDR = "0x" + "0".repeat(40);

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const tx = params[0] as CallParams;
      // blockTag = params[1] — ignored, always latest finalized

      if (!tx.to) {
        throw { code: -32602, message: "eth_call requires 'to' address" };
      }

      const from = tx.from ?? ZERO_ADDR;
      const to = tx.to;
      const value = tx.value ? weiToPlanck(toBigInt(tx.value)) : 0n;
      const input = tx.data ? hexToBytes(tx.data) : new Uint8Array(0);

      // Cache key based on to + data (deterministic for read-only calls)
      const cacheKey = `call:${to.toLowerCase()}:${tx.data ?? "0x"}`;
      const cached = ctx.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;

      // Encode ReviveApi_call args IN METADATA ORDER:
      //   origin (AccountId32) · dest (H160) · value (u128) ·
      //   gas_limit None · storage_deposit_limit None · input_data (Bytes)
      const encoded = concatBytes(
        encodeReviveOrigin(from),
        encodeH160(to),
        encodeU128(value),
        new Uint8Array([0]), // gas_limit = None
        new Uint8Array([0]), // storage_deposit_limit = None
        encodeBytes(input),
      );

      const resultBytes = await ctx.chainManager.runtimeCall("ReviveApi_call", encoded);
      const output = extractCallOutput(resultBytes);

      ctx.cache.set(cacheKey, output, ctx.config.cache?.stateTtlMs);
      return output;
    },
  };
}

/**
 * Decode the EVM return data from a `PalletRevivePrimitivesContractResultExecReturnValue`.
 *
 * Exact SCALE layout (verified byte-for-byte against a live reviveApi.call):
 *   weightConsumed    : Weight { refTime: Compact<u64>, proofSize: Compact<u64> }
 *   weightRequired    : Weight { refTime: Compact<u64>, proofSize: Compact<u64> }
 *   storageDeposit    : StorageDeposit  (1-byte variant + u128)
 *   maxStorageDeposit : StorageDeposit  (1-byte variant + u128)
 *   gasConsumed       : u128            (16 bytes)
 *   result            : Result<ExecReturnValue, DispatchError>
 *                         Ok(0x00)  + ExecReturnValue { flags: u32(LE), data: Vec<u8> }
 *                         Err(0x01) + DispatchError
 *
 * This is parsed precisely (no offset guessing). On a runtime layout change it
 * throws loudly rather than silently returning "0x" with the wrong data.
 */
export function extractCallOutput(data: Uint8Array): string {
  if (data.length === 0) return "0x";
  let o = 0;
  const skipCompact = () => {
    o += decodeCompact(data, o)[1];
  };

  // weightConsumed + weightRequired — two compacts each
  skipCompact();
  skipCompact();
  skipCompact();
  skipCompact();
  // storageDeposit + maxStorageDeposit — each: 1-byte variant + u128(16)
  o += 1 + 16;
  o += 1 + 16;
  // gasConsumed — u128
  o += 16;

  if (o >= data.length) {
    throw { code: -32603, message: "pine: ContractResult parse overran preamble (runtime layout drift?)" };
  }

  // result: Result<ExecReturnValue, DispatchError>
  const variant = data[o++];
  if (variant === 1) {
    // Err(DispatchError) — surface as an EVM revert.
    throw { code: 3, message: "execution reverted", data: "0x" + bytesToHex(data.slice(o)) };
  }
  if (variant !== 0) {
    throw { code: -32603, message: `pine: unexpected ContractResult variant ${variant}` };
  }

  // Ok: ExecReturnValue { flags: ReturnFlags(u32 LE), data: Vec<u8> }
  if (o + 4 > data.length) {
    throw { code: -32603, message: "pine: ContractResult truncated before flags" };
  }
  const flags = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
  o += 4;
  const [len, n] = decodeCompact(data, o);
  o += n;
  const out = data.slice(o, o + len);

  // ReturnFlags bit0 = the contract called `revert` (data holds the reason).
  if (flags & 1) {
    throw { code: 3, message: "execution reverted", data: "0x" + bytesToHex(out) };
  }
  return out.length > 0 ? "0x" + bytesToHex(out) : "0x";
}

registerMethod("eth_call", factory);
