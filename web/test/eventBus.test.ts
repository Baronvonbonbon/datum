import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the provider module BEFORE importing eventBus so it picks up
// the stubs at module-load time. We keep a settable `pineMock` so
// individual tests can program responses.

let pineRpcMock: ReturnType<typeof vi.fn>;
let onPineStatusMock: ReturnType<typeof vi.fn>;
let statusListeners: Array<(s: any) => void> = [];

vi.mock("../src/lib/provider", () => ({
  pineRpc: (...args: unknown[]) => pineRpcMock(...args),
  onPineStatus: (listener: (s: any) => void) => onPineStatusMock(listener),
  // Re-export the types so eventBus imports `type PineStatus` resolves.
}));

vi.mock("../src/lib/rpcSettings", () => ({
  getRpcEndpoint: () => "https://example-rpc.test/",
  DEFAULT_RPC_ENDPOINT: "https://example-rpc.test/",
}));

// Import AFTER mocks are registered.
const eventBusModule = await import("../src/lib/eventBus");
const { subscribeLogs, __test } = eventBusModule;

beforeEach(() => {
  pineRpcMock = vi.fn(async () => []);
  onPineStatusMock = vi.fn((listener) => {
    statusListeners.push(listener);
    return () => {
      statusListeners = statusListeners.filter((l) => l !== listener);
    };
  });
  statusListeners = [];
  __test.reset();
});

afterEach(() => {
  __test.reset();
  vi.restoreAllMocks();
});

function fireStatus(opts: { finalizedHead: number; indexedFromBlock?: number }) {
  const s = {
    state: "ready" as const,
    step: "connected",
    peers: 1,
    finalizedHead: opts.finalizedHead,
    indexedFromBlock: opts.indexedFromBlock ?? 0,
  };
  for (const l of statusListeners) l(s);
}

function fakeLog(blockNumber: number, logIndex: number, address = "0xaaa"): any {
  return {
    address,
    topics: ["0xtopic"],
    data: "0x",
    blockNumber: "0x" + blockNumber.toString(16),
    transactionHash: `0xtx${blockNumber}-${logIndex}`,
    transactionIndex: "0x0",
    blockHash: "0xhash",
    logIndex: "0x" + logIndex.toString(16),
    removed: false,
  };
}

describe("eventBus subscribe lifecycle", () => {
  it("first subscribe creates a channel; teardown removes it", async () => {
    const emissions: any[] = [];
    const unsub = subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      (e) => emissions.push(e)
    );
    expect(__test.channelCount()).toBe(1);
    unsub();
    expect(__test.channelCount()).toBe(0);
  });

  it("multiple subscribers share a single channel", async () => {
    const unsub1 = subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    const unsub2 = subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 50, historyAllowed: false },
      () => undefined
    );
    expect(__test.channelCount()).toBe(1);
    unsub1();
    expect(__test.channelCount()).toBe(1);
    unsub2();
    expect(__test.channelCount()).toBe(0);
  });

  it("distinct addresses or topic0 create separate channels", async () => {
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    subscribeLogs(
      { address: "0xabc", topic0: "0xother", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    subscribeLogs(
      { address: "0xdef", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    expect(__test.channelCount()).toBe(3);
  });
});

describe("eventBus bootstrap", () => {
  it("delivers historical logs from pine when window is within pine's coverage", async () => {
    pineRpcMock.mockImplementation(async (_method: string, params: any[]) => {
      const filter = params[0];
      const fromBlock = Number(BigInt(filter.fromBlock));
      const toBlock = Number(BigInt(filter.toBlock));
      // Return a log per block in the range.
      const logs = [];
      for (let b = fromBlock; b <= toBlock; b++) {
        logs.push(fakeLog(b, 0));
      }
      return logs;
    });

    const emissions: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 5, historyAllowed: false },
      (e) => emissions.push(e)
    );
    // Bootstrap waits on pine status — fire ready.
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    // Yield so the async bootstrap resolves.
    await new Promise((r) => setTimeout(r, 10));

    expect(emissions.length).toBeGreaterThanOrEqual(1);
    const first = emissions[0];
    expect(first.viaRpc).toBe(false);
    // Should include the last 5 blocks (95..100).
    expect(first.logs.length).toBe(6); // inclusive range 95..100
  });

  it("emits truncatedTo when pine's window is shorter than requested and historyAllowed=false", async () => {
    pineRpcMock.mockResolvedValue([fakeLog(800, 0)]);
    const emissions: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 500, historyAllowed: false },
      (e) => emissions.push(e)
    );
    // Pine indexed since block 800; user requested 500..1000.
    fireStatus({ finalizedHead: 1000, indexedFromBlock: 800 });
    await new Promise((r) => setTimeout(r, 10));

    expect(emissions[0].viaRpc).toBe(false);
    expect(emissions[0].truncatedTo).toBe(800);
  });

  it("splices RPC + pine when historyAllowed=true and pine's window is short", async () => {
    pineRpcMock.mockImplementation(async () => [fakeLog(900, 0)]);
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({ result: [fakeLog(550, 0)] }),
      } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const emissions: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 500, historyAllowed: true },
      (e) => emissions.push(e)
    );
    fireStatus({ finalizedHead: 1000, indexedFromBlock: 800 });
    await new Promise((r) => setTimeout(r, 10));

    expect(emissions[0].viaRpc).toBe(true);
    expect(emissions[0].logs.map((l: any) => Number(BigInt(l.blockNumber)))).toEqual([
      550,
      900,
    ]);
    vi.unstubAllGlobals();
  });

  it("survives RPC fetch failure (operator route) — pine slice still emitted", async () => {
    pineRpcMock.mockImplementation(async () => [fakeLog(900, 0)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("DNS busted");
      })
    );

    const emissions: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 500, historyAllowed: true },
      (e) => emissions.push(e)
    );
    fireStatus({ finalizedHead: 1000, indexedFromBlock: 800 });
    await new Promise((r) => setTimeout(r, 10));

    // viaRpc=false because the RPC slice failed; pine slice still present.
    expect(emissions[0].viaRpc).toBe(false);
    expect(emissions[0].logs.length).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("eventBus live ticks", () => {
  it("fans new logs to all subscribers on each head tick", async () => {
    // Bootstrap: return empty so first tick is the real measurement.
    pineRpcMock.mockResolvedValueOnce([]);
    const a: any[] = [];
    const b: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      (e) => a.push(e)
    );
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      (e) => b.push(e)
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    // Subsequent head tick at 101 emits one new log.
    pineRpcMock.mockResolvedValueOnce([fakeLog(101, 0)]);
    await __test.tickHead(101);
    await new Promise((r) => setTimeout(r, 10));

    // Each subscriber got a live emission (in addition to the
    // bootstrap one).
    const aLive = a.find((e) => e.logs.length === 1);
    const bLive = b.find((e) => e.logs.length === 1);
    expect(aLive).toBeDefined();
    expect(bLive).toBeDefined();
    expect(aLive.logs[0].blockNumber).toBe("0x65"); // 101
  });

  it("dedupes pine calls when multiple subscribers share a channel", async () => {
    pineRpcMock.mockResolvedValue([]);
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    // Tick once: one pine call regardless of subscriber count.
    pineRpcMock.mockClear();
    await __test.tickHead(101);
    await new Promise((r) => setTimeout(r, 10));
    expect(pineRpcMock).toHaveBeenCalledTimes(1);
  });

  it("respects each subscriber's windowBlocks when slicing live emissions", async () => {
    pineRpcMock.mockResolvedValue([]);
    const wide: any[] = [];
    const narrow: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 1000, historyAllowed: false },
      (e) => wide.push(e)
    );
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 0, historyAllowed: false },
      (e) => narrow.push(e)
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    // Emit logs across blocks 99, 100, 101.
    pineRpcMock.mockResolvedValueOnce([fakeLog(99, 0), fakeLog(100, 0), fakeLog(101, 0)]);
    await __test.tickHead(105);
    await new Promise((r) => setTimeout(r, 10));

    // Wide window includes all three.
    expect(wide.some((e) => e.logs.length === 3)).toBe(true);
    // Narrow (windowBlocks=0) — fromBlock = 105 - 0 = 105;
    // logs are at 99/100/101 → all filtered out, no emission.
    // (We don't deliver empty emissions.)
    expect(narrow.some((e) => e.logs.length === 3)).toBe(false);
  });

  it("ignores head ticks where head <= lastSeenHead", async () => {
    pineRpcMock.mockResolvedValue([]);
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => undefined
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    pineRpcMock.mockClear();
    // Replay same head — should noop.
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(pineRpcMock).not.toHaveBeenCalled();
  });
});

describe("eventBus error handling", () => {
  it("subscriber listener errors don't block other subscribers", async () => {
    pineRpcMock.mockResolvedValue([]);
    const good: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      () => {
        throw new Error("intentional");
      }
    );
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      (e) => good.push(e)
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    // Live tick — fan-out must still hit `good` even though the other
    // subscriber throws.
    pineRpcMock.mockResolvedValueOnce([fakeLog(101, 0)]);
    await __test.tickHead(101);
    await new Promise((r) => setTimeout(r, 10));
    expect(good.find((e) => e.logs.length === 1)).toBeDefined();
  });

  it("pine errors don't kill the channel — next tick retries", async () => {
    pineRpcMock.mockResolvedValue([]);
    const got: any[] = [];
    subscribeLogs(
      { address: "0xabc", topic0: "0xtopic", windowBlocks: 100, historyAllowed: false },
      (e) => got.push(e)
    );
    fireStatus({ finalizedHead: 100, indexedFromBlock: 0 });
    await new Promise((r) => setTimeout(r, 10));

    // First tick fails.
    pineRpcMock.mockRejectedValueOnce(new Error("pine kaboom"));
    await __test.tickHead(101);
    await new Promise((r) => setTimeout(r, 10));

    // Next tick succeeds.
    pineRpcMock.mockResolvedValueOnce([fakeLog(102, 0)]);
    await __test.tickHead(102);
    await new Promise((r) => setTimeout(r, 10));

    expect(got.some((e) => e.logs[0]?.blockNumber === "0x66")).toBe(true);
  });
});
