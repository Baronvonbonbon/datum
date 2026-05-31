// ── eth_estimateGas → ReviveApi_call (weightRequired) ──
//
// There is NO `ReviveApi_estimate_gas` runtime API on Asset Hub — the original
// implementation called a non-existent method and always failed. Gas estimation
// is derived from a dry-run `ReviveApi_call`: its ContractResult carries
// `weightRequired`, whose `refTime` we convert to gas (+20% margin). Args match
// eth_call exactly (origin = AccountId32 mapping, value = u128, input last).
import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import {
  encodeH160,
  encodeReviveOrigin,
  encodeU128,
  encodeBytes,
  concatBytes,
  hexToBytes,
  decodeCompact,
} from "../codec/scale.js";
import { weiToPlanck, toBigInt, toHex } from "../codec/denomination.js";
import { weightToGas } from "../codec/gas.js";
import { extractCallOutput } from "./eth_call.js";

interface TxParams {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
}

const ZERO_ADDR = "0x" + "0".repeat(40);

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<string> {
      const tx = params[0] as TxParams;

      const from = tx.from ?? ZERO_ADDR;
      const to = tx.to ?? ZERO_ADDR;
      const value = tx.value ? weiToPlanck(toBigInt(tx.value)) : 0n;
      const input = tx.data ? hexToBytes(tx.data) : new Uint8Array(0);

      // Same args + order as eth_call (reviveApi.call).
      const encoded = concatBytes(
        encodeReviveOrigin(from),
        encodeH160(to),
        encodeU128(value),
        new Uint8Array([0]), // gas_limit = None
        new Uint8Array([0]), // storage_deposit_limit = None
        encodeBytes(input),
      );

      const resultBytes = await ctx.chainManager.runtimeCall("ReviveApi_call", encoded);

      // Surface a revert (Err / ReturnFlags revert) as a failed estimate.
      extractCallOutput(resultBytes);

      // ContractResult preamble: weightConsumed { refTime: Compact, proofSize: Compact },
      // then weightRequired { refTime: Compact, ... }. We want weightRequired.refTime.
      let o = 0;
      o += decodeCompact(resultBytes, o)[1]; // weightConsumed.refTime
      o += decodeCompact(resultBytes, o)[1]; // weightConsumed.proofSize
      const [refTime] = decodeCompact(resultBytes, o); // weightRequired.refTime

      const gas = weightToGas(BigInt(refTime));
      const gasWithMargin = gas + gas / 5n; // +20% margin
      return toHex(gasWithMargin);
    },
  };
}

registerMethod("eth_estimateGas", factory);
