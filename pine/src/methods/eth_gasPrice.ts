import type { MethodContext, MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";

// Paseo / Asset Hub gas price is fixed at 10^12 wei per gas unit.
// This matches what the centralized eth-rpc proxy returns.
const DEFAULT_GAS_PRICE = "0xe8d4a51000"; // 10^12

function factory(_ctx: MethodContext): MethodHandler {
  return {
    async execute(_params: unknown[]): Promise<string> {
      return DEFAULT_GAS_PRICE;
    },
  };
}

registerMethod("eth_gasPrice", factory);
