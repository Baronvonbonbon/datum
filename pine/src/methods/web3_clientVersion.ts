import type { MethodHandler } from "../types.js";
import { registerMethod } from "./registry.js";

function factory(): MethodHandler {
  return {
    async execute(_params: unknown[]): Promise<string> {
      return "Pine/0.1.0";
    },
  };
}

registerMethod("web3_clientVersion", factory);
