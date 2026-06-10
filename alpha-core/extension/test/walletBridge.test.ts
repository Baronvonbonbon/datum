/**
 * @jest-environment jsdom
 */
// Unit tests for content/walletBridge.ts.
//
// The bridge is a thin relay — its responsibilities are:
//   - Accept `datum:rpc:request` postMessages
//   - Forward via chrome.runtime.sendMessage as WALLET_PROVIDER_REQUEST
//   - Post the reply back tagged as `datum:bridge`
//   - Forward background-pushed PROVIDER_EVENT messages into the page
//
// We mount the module in a jsdom environment so window.postMessage
// behaves naturally, mock chrome.runtime, and assert on the relay
// roundtrip.

import type { WalletProviderResponse } from "../src/shared/messages";

type RuntimeMsgHandler = (msg: any, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;

let pageMessages: MessageEvent[];
let bgSendMessage: jest.Mock;
let onMessageListeners: RuntimeMsgHandler[];
let mockLastError: { message: string } | undefined;

beforeEach(async () => {
  jest.resetModules();
  pageMessages = [];
  onMessageListeners = [];
  mockLastError = undefined;

  // Capture every message dispatched on window so tests can inspect.
  window.addEventListener("message", (e) => pageMessages.push(e));

  bgSendMessage = jest.fn();
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: bgSendMessage,
      onMessage: {
        addListener: (h: RuntimeMsgHandler) => onMessageListeners.push(h),
      },
      get lastError() {
        return mockLastError;
      },
    },
  };

  // Load the bridge fresh each test so its installation guard resets.
  // The bridge installs at import time.
  delete (window as any).__datumBridgeInstalled;
  await import("../src/content/walletBridge");
  // Drain the initial message tick so tests observe a clean slate.
  await new Promise((r) => setTimeout(r, 0));
  pageMessages.length = 0;
});

async function flushMessages() {
  // jsdom's window.postMessage is async; multiple ticks needed when
  // the relay chain is bridge → mock-sendMessage cb → reply post →
  // window listener.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
}

function postPageRequest(method: string, params: unknown[] = [], requestId = "req-1") {
  window.postMessage(
    {
      source: "datum:page",
      type: "datum:rpc:request",
      requestId,
      method,
      params,
    },
    "*"
  );
}

describe("walletBridge: page → background forwarding", () => {
  it("forwards a datum:rpc:request as WALLET_PROVIDER_REQUEST", async () => {
    bgSendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
      const reply: WalletProviderResponse = {
        type: "WALLET_PROVIDER_RESPONSE",
        requestId: "req-1",
        ok: true,
        result: "0x1",
      };
      cb?.(reply);
    });

    postPageRequest("eth_chainId");
    await flushMessages();

    expect(bgSendMessage).toHaveBeenCalledTimes(1);
    const sent = bgSendMessage.mock.calls[0][0];
    expect(sent.type).toBe("WALLET_PROVIDER_REQUEST");
    expect(sent.method).toBe("eth_chainId");
    expect(sent.requestId).toBe("req-1");

    const replyMsg = pageMessages.find((m) => m.data?.source === "datum:bridge");
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.data).toMatchObject({
      type: "datum:rpc:response",
      requestId: "req-1",
      ok: true,
      result: "0x1",
    });
  });

  it("forwards the EIP-1193 error envelope on ok=false", async () => {
    bgSendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
      cb?.({
        type: "WALLET_PROVIDER_RESPONSE",
        requestId: "req-1",
        ok: false,
        error: { code: 4001, message: "User rejected" },
      } as WalletProviderResponse);
    });

    postPageRequest("eth_requestAccounts");
    await flushMessages();

    const replyMsg = pageMessages.find((m) => m.data?.source === "datum:bridge");
    expect(replyMsg!.data).toMatchObject({
      type: "datum:rpc:response",
      ok: false,
      error: { code: 4001, message: "User rejected" },
    });
  });

  it("translates chrome.runtime.lastError into a -32603 error", async () => {
    bgSendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
      mockLastError = { message: "Background unreachable" };
      cb?.(undefined);
      mockLastError = undefined;
    });

    postPageRequest("eth_chainId");
    await flushMessages();

    const replyMsg = pageMessages.find((m) => m.data?.source === "datum:bridge");
    expect(replyMsg!.data).toMatchObject({
      ok: false,
      error: { code: -32603 },
    });
    expect((replyMsg!.data as any).error.message).toMatch(/unreachable/i);
  });

  it("emits a malformed-reply error when background returns an unexpected shape", async () => {
    bgSendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
      cb?.({ random: "garbage" });
    });

    postPageRequest("eth_chainId");
    await flushMessages();

    const replyMsg = pageMessages.find((m) => m.data?.source === "datum:bridge");
    expect(replyMsg!.data).toMatchObject({
      ok: false,
      error: { code: -32603 },
    });
  });

  it("ignores postMessages that are not source: datum:page", async () => {
    bgSendMessage.mockClear();
    window.postMessage({ random: "data" }, "*");
    window.postMessage({ source: "other:ext", type: "x" }, "*");
    await flushMessages();
    expect(bgSendMessage).not.toHaveBeenCalled();
  });

  it("ignores datum:bridge replies (no self-loop)", async () => {
    bgSendMessage.mockClear();
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId: "x",
        ok: true,
      },
      "*"
    );
    await flushMessages();
    expect(bgSendMessage).not.toHaveBeenCalled();
  });

  it("sets the install guard so re-injection is a noop", async () => {
    expect((window as any).__datumBridgeInstalled).toBe(true);
  });
});

describe("walletBridge: background → page event push", () => {
  it("forwards PROVIDER_EVENT messages as datum:event postMessages", async () => {
    expect(onMessageListeners).toHaveLength(1);
    onMessageListeners[0](
      {
        type: "PROVIDER_EVENT",
        event: "accountsChanged",
        data: ["0xabc"],
      },
      null,
      () => undefined
    );
    await flushMessages();

    const evtMsg = pageMessages.find((m) => m.data?.type === "datum:event");
    expect(evtMsg).toBeDefined();
    expect(evtMsg!.data).toMatchObject({
      source: "datum:bridge",
      type: "datum:event",
      event: "accountsChanged",
      data: ["0xabc"],
    });
  });

  it("ignores runtime messages that are not PROVIDER_EVENT", async () => {
    onMessageListeners[0](
      { type: "SOMETHING_ELSE", payload: 1 },
      null,
      () => undefined
    );
    await flushMessages();
    expect(pageMessages.find((m) => m.data?.type === "datum:event")).toBeUndefined();
  });
});
