// Decoder test for eth_call's ContractResult parser, using fixtures captured
// from a live `reviveApi.call` on Paseo Asset Hub (via @polkadot/api).
import { describe, it, expect } from "vitest";
import { extractCallOutput } from "../../src/methods/eth_call.js";
import { hexToBytes } from "../../src/codec/scale.js";

// userMinAssurance(alice) → Ok, EVM return = uint8 0 (32-byte zero).
// origin correctly mapped (h160 ++ 0xEE×12); full 104-byte ContractResult.
const OK =
  "2ebb8318365801002ebb83183658010001000000000000000000000000000000000100000000000000000000000000000000640000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000";

// Same call with an UNMAPPED origin → Err(Module{index:100,error:0x2b}).
const ERR =
  "0000000001000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000103642b000000";

describe("eth_call ContractResult decoder (live fixtures)", () => {
  it("decodes Ok → the 32-byte EVM return data", () => {
    expect(extractCallOutput(hexToBytes(OK))).toBe("0x" + "00".repeat(32));
  });

  it("throws 'execution reverted' on an Err(DispatchError) result", () => {
    expect(() => extractCallOutput(hexToBytes(ERR))).toThrowError(/execution reverted/);
  });

  it("returns 0x for an empty buffer", () => {
    expect(extractCallOutput(new Uint8Array(0))).toBe("0x");
  });
});
