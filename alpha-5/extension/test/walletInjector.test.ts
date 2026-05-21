/**
 * @jest-environment jsdom
 */
// Tests for content/walletInjector.ts (MAIN world).
//
// Asserts the injection surface a dApp sees: window.datum has the
// expected shape (request, on/removeListener, isDatum), EIP-6963
// announcements fire, request() messages flow out to the bridge,
// and responses tagged as "datum:bridge" resolve the right Promise.

const announced: Array<{ info: any; provider: any }> = [];
const bridgeRequests: Array<{ requestId: string; method: string; params: unknown[] }> = [];

// Single install — the injector's listeners stick to window for the
// life of the jsdom environment. We intercept window.postMessage to
// capture outgoing bridge calls deterministically (bypasses jsdom's
// async message-event scheduling that made the listener approach
// flaky).
const realPostMessage = window.postMessage.bind(window);

beforeAll(async () => {
  window.addEventListener("eip6963:announceProvider", (e: any) => {
    announced.push(e.detail);
  });

  (window as any).postMessage = (data: any, target?: any) => {
    if (data?.source === "datum:page" && data?.type === "datum:rpc:request") {
      bridgeRequests.push({
        requestId: data.requestId,
        method: data.method,
        params: data.params,
      });
    }
    return realPostMessage(data, target ?? "*");
  };

  await import("../src/content/walletInjector");
  await new Promise((r) => setTimeout(r, 30));
});

beforeEach(() => {
  bridgeRequests.length = 0;
});

async function flush() {
  // jsdom's window.postMessage propagates asynchronously; the test
  // listener captures via addEventListener("message", ...) which
  // fires after the next macrotask. Multiple yields give the message
  // queue time to drain.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
}

describe("walletInjector: shape + discovery", () => {
  it("installs window.datum with the expected surface", () => {
    const d = (window as any).datum;
    expect(d).toBeDefined();
    expect(typeof d.request).toBe("function");
    expect(typeof d.on).toBe("function");
    expect(typeof d.removeListener).toBe("function");
    expect(d.isDatum).toBe(true);
  });

  it("fires an EIP-6963 announceProvider with the expected info shape", async () => {
    expect(announced.length).toBeGreaterThan(0);
    const last = announced[announced.length - 1];
    expect(last.info.name).toBe("DATUM");
    expect(last.info.rdns).toBe("io.javcon.datum");
    expect(typeof last.info.uuid).toBe("string");
    expect(last.info.icon).toMatch(/^data:image\/svg/);
    expect(last.provider).toBe((window as any).datum);
  });

  it("re-announces on eip6963:requestProvider", async () => {
    announced.length = 0;
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await flush();
    expect(announced.length).toBe(1);
  });
});

describe("walletInjector: request relay", () => {
  it("forwards request() as a datum:rpc:request postMessage", async () => {
    const d = (window as any).datum;
    const p = d.request({ method: "eth_chainId" });
    await flush();
    expect(bridgeRequests.length).toBe(1);
    expect(bridgeRequests[0].method).toBe("eth_chainId");
    expect(bridgeRequests[0].params).toEqual([]);
    // Reply tagged as bridge so the injector resolves it.
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId: bridgeRequests[0].requestId,
        ok: true,
        result: "0x190f1b41",
      },
      "*"
    );
    await flush();
    await expect(p).resolves.toBe("0x190f1b41");
  });

  it("rejects with the EIP-1193 error envelope on ok=false", async () => {
    const d = (window as any).datum;
    // Convert the rejection to a resolution synchronously so Node's
    // unhandled-rejection telemetry doesn't fire between the post
    // and the assertion.
    const captured = d.request({ method: "eth_requestAccounts" }).catch((e: unknown) => e);
    await flush();
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId: bridgeRequests[0].requestId,
        ok: false,
        error: { code: 4001, message: "User rejected" },
      },
      "*"
    );
    await flush();
    expect(await captured).toMatchObject({ code: 4001, message: "User rejected" });
  });

  it("rejects with invalid-request when caller omits method", async () => {
    const d = (window as any).datum;
    // Capture as a resolution so we don't trip Node's unhandled-rejection
    // telemetry between the synchronous reject and the assertion.
    const captured = d.request({}).catch((e: unknown) => e);
    expect(await captured).toMatchObject({ code: -32602 });
  });

  it("supports concurrent requests resolving independently", async () => {
    const d = (window as any).datum;
    const p1 = d.request({ method: "eth_chainId" });
    const p2 = d.request({ method: "eth_blockNumber" });
    await flush();
    expect(bridgeRequests.length).toBe(2);

    // Respond out of order.
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId: bridgeRequests[1].requestId,
        ok: true,
        result: "0x100",
      },
      "*"
    );
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId: bridgeRequests[0].requestId,
        ok: true,
        result: "0x190f1b41",
      },
      "*"
    );
    await flush();
    await expect(p1).resolves.toBe("0x190f1b41");
    await expect(p2).resolves.toBe("0x100");
  });
});

describe("walletInjector: events", () => {
  it("emits accountsChanged when the bridge pushes a matching event", async () => {
    const d = (window as any).datum;
    const seen: unknown[] = [];
    d.on("accountsChanged", (data: unknown) => seen.push(data));

    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:event",
        event: "accountsChanged",
        data: ["0xabc"],
      },
      "*"
    );
    await flush();
    expect(seen).toEqual([["0xabc"]]);
  });

  it("removeListener stops further deliveries", async () => {
    const d = (window as any).datum;
    const seen: unknown[] = [];
    const fn = (data: unknown) => seen.push(data);
    d.on("chainChanged", fn);
    d.removeListener("chainChanged", fn);

    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:event",
        event: "chainChanged",
        data: "0x190f1b41",
      },
      "*"
    );
    await flush();
    expect(seen).toEqual([]);
  });
});
