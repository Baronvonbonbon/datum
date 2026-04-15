// ── eth_call → ReviveApi_call ──
//
// This is the most important method — all contract reads go through here.
// ReviveApi_call(origin: H160, dest: H160, value: U256, input: Vec<u8>,
//               gas_limit: Option<Weight>, storage_deposit_limit: Option<U256>)
//   → ContractResult<ExecReturnValue>

import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";
import {
  encodeH160,
  encodeU256,
  encodeBytes,
  concatBytes,
  bytesToHex,
  hexToBytes,
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

      // Encode ReviveApi_call arguments:
      //   origin: H160 (20 bytes)
      //   dest: H160 (20 bytes)
      //   value: U256 (32 bytes LE)
      //   input_data: Vec<u8> (compact length + bytes)
      //   gas_limit: None (0x00 for Option)
      //   storage_deposit_limit: None (0x00 for Option)
      const encoded = concatBytes(
        encodeH160(from),
        encodeH160(to),
        encodeU256(value),
        encodeBytes(input),
        new Uint8Array([0]), // gas_limit = None
        new Uint8Array([0]), // storage_deposit_limit = None
      );

      const resultBytes = await ctx.chainManager.runtimeCall(
        "ReviveApi_call",
        encoded,
      );

      // Parse ContractResult — the output data is nested inside:
      //   Result<ExecReturnValue, DispatchError>
      //     ExecReturnValue { flags: u32, data: Vec<u8> }
      //
      // For a successful call, the structure is:
      //   gas_consumed(Weight) + gas_required(Weight) + storage_deposit(i128) +
      //   debug_message(Vec<u8>) + result(Result<ExecReturnValue, DispatchError>)
      //
      // This is complex SCALE — for now, extract the return data heuristically
      // by looking for the output bytes after the fixed-size preamble.
      const output = extractCallOutput(resultBytes);

      ctx.cache.set(cacheKey, output, ctx.config.cache?.stateTtlMs);
      return output;
    },
  };
}

/**
 * Extract the EVM return data from a ReviveApi_call result.
 *
 * The full ContractResult structure is complex. We parse it step by step:
 *   - gas_consumed: { ref_time: u64, proof_size: u64 } = 16 bytes
 *   - gas_required: { ref_time: u64, proof_size: u64 } = 16 bytes
 *   - storage_deposit: { charge_or_refund: i128, ... } ≈ 17+ bytes
 *   - debug_message: Vec<u8> = compact(0) + ...
 *   - result: Result<ExecReturnValue, DispatchError>
 *     - Ok(0x00) + ExecReturnValue { flags: u32(LE), data: Vec<u8> }
 *     - Err(0x01) + DispatchError
 *
 * Since the exact offsets depend on the runtime version, we use a
 * more robust approach: scan for the Result variant from a known offset.
 */
function extractCallOutput(data: Uint8Array): string {
  if (data.length === 0) return "0x";

  // Skip gas_consumed (16) + gas_required (16) = 32 bytes
  let offset = 32;

  // storage_deposit: enum StorageDeposit { Refund(Balance), Charge(Balance) }
  // = 1 byte variant + 16 bytes (u128)
  offset += 17;

  // debug_message: Vec<u8> — compact length prefix
  if (offset >= data.length) return "0x";
  const mode = data[offset] & 0x03;
  let compactLen = 1;
  if (mode === 1) compactLen = 2;
  else if (mode === 2) compactLen = 4;
  else if (mode === 3) compactLen = (data[offset] >> 2) + 5;
  const debugMsgLen = decodeCompactAt(data, offset);
  offset += compactLen + debugMsgLen;

  // result: Result<ExecReturnValue, DispatchError>
  if (offset >= data.length) return "0x";
  const resultVariant = data[offset];
  offset += 1;

  if (resultVariant === 1) {
    // Err — call reverted or failed
    // Try to extract revert data if present
    throw { code: 3, message: "execution reverted", data: "0x" };
  }

  // Ok — ExecReturnValue { flags: ReturnFlags(u32), data: Vec<u8> }
  if (offset + 4 >= data.length) return "0x";
  const flags = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
  offset += 4;

  // If revert flag is set (bit 0)
  if (flags & 1) {
    // Revert — data contains revert reason
    const revertData = decodeVecAt(data, offset);
    throw { code: 3, message: "execution reverted", data: "0x" + bytesToHex(revertData) };
  }

  // Success — extract output Vec<u8>
  const outputData = decodeVecAt(data, offset);
  return outputData.length > 0 ? "0x" + bytesToHex(outputData) : "0x";
}

function decodeCompactAt(data: Uint8Array, offset: number): number {
  const mode = data[offset] & 0x03;
  if (mode === 0) return data[offset] >> 2;
  if (mode === 1) return (data[offset] | (data[offset + 1] << 8)) >> 2;
  if (mode === 2) {
    return ((data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 2);
  }
  const numBytes = (data[offset] >> 2) + 4;
  let value = 0;
  for (let i = numBytes - 1; i >= 0; i--) {
    value = value * 256 + data[offset + 1 + i];
  }
  return value;
}

function compactSize(data: Uint8Array, offset: number): number {
  const mode = data[offset] & 0x03;
  if (mode === 0) return 1;
  if (mode === 1) return 2;
  if (mode === 2) return 4;
  return (data[offset] >> 2) + 5;
}

function decodeVecAt(data: Uint8Array, offset: number): Uint8Array {
  const len = decodeCompactAt(data, offset);
  const headerSize = compactSize(data, offset);
  return data.slice(offset + headerSize, offset + headerSize + len);
}

registerMethod("eth_call", factory);
