import { describe, it, expect, beforeEach, vi } from "vitest";
import { queryWithFallback, queryPineOnly } from "../src/lib/query";
import { __test as providerTest } from "../src/lib/provider";

// Tests exercise the routing primitive in isolation by driving the
// provider's status snapshot via the test helper. No real pine
// network is touched.

beforeEach(() => {
  providerTest.reset();
});

function setReady(opts: { finalizedHead: number; indexedFromBlock: number }) {
  providerTest.setStatus({
    state: "ready",
    step: "connected",
    peers: 3,
    finalizedHead: opts.finalizedHead,
    indexedFromBlock: opts.indexedFromBlock,
  });
}

describe("queryWithFallback routing", () => {
  it("throws when pine isn't ready", async () => {
    await expect(
      queryWithFallback({
        pine: async () => [],
        windowBlocks: 100,
        historyAllowed: false,
      })
    ).rejects.toThrow(/pine not ready/);
  });

  it("Case A: pine's window covers the request — pine-only, viaRpc=false", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 500 });
    // Window of 100 → fromBlock=900 ≥ pineFloor=500. Pine handles it.
    const pine = vi.fn(async (from: number, to: number) => ({ from, to, src: "pine" }));
    const r = await queryWithFallback({
      pine,
      windowBlocks: 100,
      historyAllowed: false,
    });
    expect(r.viaRpc).toBe(false);
    expect(r.truncatedTo).toBeUndefined();
    expect(pine).toHaveBeenCalledWith(900, 1000);
    expect(r.data).toEqual({ from: 900, to: 1000, src: "pine" });
  });

  it("Case B: pine short + historyAllowed=false → truncate", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 800 });
    const pine = vi.fn(async (from: number, to: number) => ({ from, to }));
    const r = await queryWithFallback({
      pine,
      windowBlocks: 500, // requested fromBlock would be 500, < pineFloor=800
      historyAllowed: false,
    });
    expect(r.viaRpc).toBe(false);
    expect(r.truncatedTo).toBe(800);
    expect(pine).toHaveBeenCalledWith(800, 1000);
  });

  it("Case C: pine short + historyAllowed=true + fallback supplied → splice", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 800 });
    const pine = vi.fn(async (from: number, to: number) => ({ blocks: [`pine:${from}-${to}`] }));
    const rpc = vi.fn(async (from: number, to: number) => ({ blocks: [`rpc:${from}-${to}`] }));
    const merge = vi.fn((older: { blocks: string[] }, newer: { blocks: string[] }) => ({
      blocks: [...older.blocks, ...newer.blocks],
    }));
    const r = await queryWithFallback({
      pine,
      rpcFallback: rpc,
      merge,
      windowBlocks: 500,
      historyAllowed: true,
    });
    expect(r.viaRpc).toBe(true);
    expect(r.truncatedTo).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(500, 799);
    expect(pine).toHaveBeenCalledWith(800, 1000);
    expect(merge).toHaveBeenCalled();
    expect(r.data.blocks).toEqual(["rpc:500-799", "pine:800-1000"]);
  });

  it("Case D: historyAllowed=true but no rpcFallback → truncate gracefully", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 800 });
    const pine = vi.fn(async (from: number, to: number) => ({ from, to }));
    const r = await queryWithFallback({
      pine,
      windowBlocks: 500,
      historyAllowed: true,
    });
    expect(r.viaRpc).toBe(false);
    expect(r.truncatedTo).toBe(800);
  });

  it("clamps requested fromBlock at 0 when window > finalizedHead", async () => {
    setReady({ finalizedHead: 100, indexedFromBlock: 0 });
    const pine = vi.fn(async (from: number, to: number) => ({ from, to }));
    const r = await queryWithFallback({
      pine,
      windowBlocks: 1_000_000, // way bigger than chain
      historyAllowed: false,
    });
    expect(pine).toHaveBeenCalledWith(0, 100);
    expect(r.viaRpc).toBe(false);
  });

  it("propagates pine errors", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 500 });
    await expect(
      queryWithFallback({
        pine: async () => {
          throw new Error("pine kaboom");
        },
        windowBlocks: 100,
        historyAllowed: false,
      })
    ).rejects.toThrow(/pine kaboom/);
  });

  it("propagates RPC fallback errors when splicing", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 800 });
    await expect(
      queryWithFallback({
        pine: async () => ({ blocks: [] as string[] }),
        rpcFallback: async () => {
          throw new Error("rpc kaboom");
        },
        merge: (a, b) => ({ blocks: [...a.blocks, ...b.blocks] }),
        windowBlocks: 500,
        historyAllowed: true,
      })
    ).rejects.toThrow(/rpc kaboom/);
  });
});

describe("queryPineOnly shorthand", () => {
  it("disables history regardless of where it's called from", async () => {
    setReady({ finalizedHead: 1000, indexedFromBlock: 800 });
    const r = await queryPineOnly({
      pine: async (from, to) => ({ from, to }),
      windowBlocks: 500,
    });
    expect(r.viaRpc).toBe(false);
    expect(r.truncatedTo).toBe(800);
  });
});
