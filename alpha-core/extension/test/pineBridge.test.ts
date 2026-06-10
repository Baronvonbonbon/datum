// Unit tests for background/pineBridge.
//
// Mocks chrome.offscreen + chrome.runtime so we can exercise the bridge
// without a real offscreen document or pine WASM. The mock simulates the
// offscreen side: it consumes BackgroundToOffscreen messages and emits
// the corresponding OffscreenToBackground replies via sendResponse, and
// independently fires PINE_STATUS broadcasts.

import type {
  BackgroundToOffscreen,
  OffscreenToBackground,
  PineStatus,
} from "../src/shared/messages";

type ChromeMessageHandler = (
  msg: any,
  sender: unknown,
  sendResponse: (reply?: unknown) => void
) => boolean | undefined;

interface MockChrome {
  runtime: {
    onMessage: { addListener: (h: ChromeMessageHandler) => void };
    sendMessage: jest.Mock;
    lastError: chrome.runtime.LastError | undefined;
  };
  offscreen: {
    hasDocument: jest.Mock;
    createDocument: jest.Mock;
    Reason: { WORKERS: string; BLOBS: string };
  };
}

let mockChrome: MockChrome;
let listeners: ChromeMessageHandler[];
let offscreenInbox: Array<{ msg: BackgroundToOffscreen; reply: OffscreenToBackground | undefined }>;
let offscreenHandler: ((msg: BackgroundToOffscreen) => OffscreenToBackground | undefined) | null;

beforeEach(() => {
  listeners = [];
  offscreenInbox = [];
  offscreenHandler = null;

  mockChrome = {
    runtime: {
      onMessage: {
        addListener(h) {
          listeners.push(h);
        },
      },
      sendMessage: jest.fn((msg: BackgroundToOffscreen, cb?: (reply: unknown) => void) => {
        // Capture in-flight messages so tests can assert on what was sent.
        const reply = offscreenHandler ? offscreenHandler(msg) : undefined;
        offscreenInbox.push({ msg, reply });
        if (cb) {
          // Async-ish reply so we exercise the callback path (real chrome
          // dispatches the reply on the next microtask).
          Promise.resolve().then(() => cb(reply));
        }
      }),
      lastError: undefined,
    },
    offscreen: {
      hasDocument: jest.fn(async () => false),
      createDocument: jest.fn(async () => undefined),
      Reason: { WORKERS: "WORKERS", BLOBS: "BLOBS" },
    },
  };

  (globalThis as any).chrome = mockChrome;

  // Force a fresh module each test so module-level state is reset.
  jest.resetModules();
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadBridge() {
  const mod = await import("../src/background/pineBridge");
  mod.__test.reset();
  return mod;
}

function broadcastStatus(s: PineStatus) {
  const reply: OffscreenToBackground = { type: "PINE_STATUS", status: s };
  for (const h of listeners) {
    h(reply as any, null, () => undefined);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("pineBridge.ensurePineReady", () => {
  it("creates the offscreen document only once even with concurrent calls", async () => {
    offscreenHandler = (msg) => {
      if (msg.type === "PINE_INIT") {
        return {
          type: "PINE_STATUS",
          status: {
            state: "ready",
            step: "connected",
            peers: 3,
            finalizedHead: 100,
            indexedFromBlock: 100,
          },
        };
      }
      return undefined;
    };

    const bridge = await loadBridge();
    await Promise.all([
      bridge.ensurePineReady(),
      bridge.ensurePineReady(),
      bridge.ensurePineReady(),
    ]);

    expect(mockChrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(
      offscreenInbox.filter((e) => e.msg.type === "PINE_INIT")
    ).toHaveLength(1);
  });

  it("does not re-create the offscreen document if hasDocument returns true", async () => {
    mockChrome.offscreen.hasDocument.mockResolvedValueOnce(true);
    offscreenHandler = (msg) => {
      if (msg.type === "PINE_INIT") {
        return {
          type: "PINE_STATUS",
          status: {
            state: "ready",
            step: "connected",
            peers: 3,
            finalizedHead: 100,
            indexedFromBlock: 100,
          },
        };
      }
      return undefined;
    };

    const bridge = await loadBridge();
    await bridge.ensurePineReady();

    expect(mockChrome.offscreen.hasDocument).toHaveBeenCalled();
    expect(mockChrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("retries on next call after a transient failure", async () => {
    mockChrome.offscreen.createDocument.mockRejectedValueOnce(new Error("transient"));
    offscreenHandler = (msg) => {
      if (msg.type === "PINE_INIT") {
        return {
          type: "PINE_STATUS",
          status: {
            state: "ready",
            step: "connected",
            peers: 2,
            finalizedHead: 50,
            indexedFromBlock: 50,
          },
        };
      }
      return undefined;
    };

    const bridge = await loadBridge();
    await expect(bridge.ensurePineReady()).rejects.toThrow("transient");

    // Second attempt should succeed.
    await expect(bridge.ensurePineReady()).resolves.toBeUndefined();
    expect(mockChrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it("uses the chain preset passed in (defaults to paseo-asset-hub)", async () => {
    offscreenHandler = (msg) => {
      if (msg.type === "PINE_INIT") {
        return {
          type: "PINE_STATUS",
          status: { state: "ready", step: "connected", peers: 1, finalizedHead: 1, indexedFromBlock: 1 },
        };
      }
      return undefined;
    };

    const bridge = await loadBridge();
    await bridge.ensurePineReady("custom-chain");

    const initMsg = offscreenInbox.find((e) => e.msg.type === "PINE_INIT")?.msg as
      | (BackgroundToOffscreen & { type: "PINE_INIT" })
      | undefined;
    expect(initMsg?.chain).toBe("custom-chain");
  });
});

describe("pineBridge.pineRpc", () => {
  beforeEach(() => {
    offscreenHandler = (msg) => {
      if (msg.type === "PINE_INIT") {
        return {
          type: "PINE_STATUS",
          status: { state: "ready", step: "connected", peers: 3, finalizedHead: 100, indexedFromBlock: 100 },
        };
      }
      if (msg.type === "PINE_RPC_REQUEST") {
        if (msg.method === "eth_blockNumber") {
          return { type: "PINE_RPC_RESULT", requestId: msg.requestId, result: "0x64" };
        }
        if (msg.method === "rejects") {
          return {
            type: "PINE_RPC_RESULT",
            requestId: msg.requestId,
            error: { code: -32000, message: "boom", data: { stack: "x" } },
          };
        }
      }
      return undefined;
    };
  });

  it("returns the result for a successful call", async () => {
    const bridge = await loadBridge();
    const head = await bridge.pineRpc<string>("eth_blockNumber");
    expect(head).toBe("0x64");
  });

  it("throws with the offscreen error code + data on JSON-RPC error", async () => {
    const bridge = await loadBridge();
    let caught: any;
    try {
      await bridge.pineRpc("rejects");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe("boom");
    expect(caught.code).toBe(-32000);
    expect(caught.data).toEqual({ stack: "x" });
  });

  it("auto-inits the offscreen pine on first call", async () => {
    const bridge = await loadBridge();
    await bridge.pineRpc("eth_blockNumber");
    expect(
      offscreenInbox.filter((e) => e.msg.type === "PINE_INIT")
    ).toHaveLength(1);
  });

  it("rejects when sendMessage reports chrome.runtime.lastError", async () => {
    // Override sendMessage to simulate a dropped channel.
    mockChrome.runtime.sendMessage.mockImplementationOnce(
      (msg: BackgroundToOffscreen, cb?: (reply: unknown) => void) => {
        mockChrome.runtime.lastError = { message: "extension reloaded" };
        if (cb) Promise.resolve().then(() => {
          cb(undefined);
          mockChrome.runtime.lastError = undefined;
        });
      }
    );

    const bridge = await loadBridge();
    // ensurePineReady will be the failing call here because it's the
    // first sendMessage. The error must surface as a rejection.
    await expect(bridge.pineRpc("eth_blockNumber")).rejects.toThrow(
      "extension reloaded"
    );
  });
});

describe("pineBridge status listeners", () => {
  it("fires subscribers with the cached value immediately", async () => {
    const bridge = await loadBridge();
    const received: PineStatus[] = [];
    bridge.onPineStatus((s) => received.push(s));
    expect(received).toHaveLength(1);
    expect(received[0].state).toBe("idle");
  });

  it("fires subscribers when a PINE_STATUS broadcast arrives", async () => {
    const bridge = await loadBridge();
    const received: PineStatus[] = [];
    bridge.onPineStatus((s) => received.push(s));

    broadcastStatus({
      state: "ready",
      step: "connected",
      peers: 5,
      finalizedHead: 200,
      indexedFromBlock: 195,
    });

    expect(received).toHaveLength(2);
    expect(received[1].state).toBe("ready");
    expect(received[1].peers).toBe(5);
  });

  it("getPineStatus reflects the most recent broadcast", async () => {
    const bridge = await loadBridge();
    broadcastStatus({
      state: "connecting",
      step: "waiting-for-peers",
      peers: 0,
      finalizedHead: 0,
      indexedFromBlock: 0,
    });
    expect(bridge.getPineStatus().state).toBe("connecting");
    expect(bridge.getPineStatus().step).toBe("waiting-for-peers");
  });

  it("unsubscribe stops further deliveries without affecting others", async () => {
    const bridge = await loadBridge();
    const a: PineStatus[] = [];
    const b: PineStatus[] = [];
    const off = bridge.onPineStatus((s) => a.push(s));
    bridge.onPineStatus((s) => b.push(s));

    off();
    broadcastStatus({
      state: "ready",
      step: "connected",
      peers: 1,
      finalizedHead: 10,
      indexedFromBlock: 10,
    });

    expect(a).toHaveLength(1); // initial cached emit only
    expect(b).toHaveLength(2); // initial + broadcast
  });

  it("status listener throw does not break other listeners", async () => {
    const bridge = await loadBridge();
    const log: string[] = [];
    bridge.onPineStatus(() => {
      throw new Error("intentional");
    });
    bridge.onPineStatus(() => log.push("ok"));

    broadcastStatus({
      state: "ready",
      step: "x",
      peers: 1,
      finalizedHead: 1,
      indexedFromBlock: 1,
    });

    // "ok" once for initial emit + once for broadcast.
    expect(log).toEqual(["ok", "ok"]);
  });
});
