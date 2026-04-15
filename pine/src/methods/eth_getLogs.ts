import type { MethodContext, MethodHandler, EthLog, EthLogFilter } from "../types.js";
import { registerMethod } from "./registry.js";

function factory(ctx: MethodContext): MethodHandler {
  return {
    async execute(params: unknown[]): Promise<EthLog[]> {
      const filter = params[0] as EthLogFilter;

      if (!ctx.logIndexer) {
        // LogIndexer not available — return empty (graceful degradation)
        return [];
      }

      return ctx.logIndexer.getLogs(filter);
    },
  };
}

registerMethod("eth_getLogs", factory);
