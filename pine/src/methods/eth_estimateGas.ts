import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import {
  encodeH160,
  encodeU256,
  encodeBytes,
  concatBytes,
  hexToBytes,
} from "../codec/scale.js";
import { weiToPlanck, toBigInt, toHex } from "../codec/denomination.js";
import { weightToGas } from "../codec/gas.js";

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

      const encoded = concatBytes(
        encodeH160(from),
        encodeH160(to),
        encodeU256(value),
        encodeBytes(input),
        new Uint8Array([0]), // gas_limit = None
        new Uint8Array([0]), // storage_deposit_limit = None
      );

      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_estimate_gas",
        encoded,
      );

      // Result contains gas_required as Weight { ref_time: u64, proof_size: u64 }
      // gas_consumed is at offset 0, gas_required at offset 16
      if (resultBytes.length < 32) {
        throw { code: -32000, message: "Failed to estimate gas" };
      }

      // Read gas_required.ref_time (u64 LE at offset 16)
      let refTime = 0n;
      for (let i = 7; i >= 0; i--) {
        refTime = (refTime << 8n) | BigInt(resultBytes[16 + i]);
      }

      const gas = weightToGas(refTime);
      // Add 20% margin for safety
      const gasWithMargin = gas + gas / 5n;

      return toHex(gasWithMargin);
    },
  };
}

registerMethod("eth_estimateGas", factory);
