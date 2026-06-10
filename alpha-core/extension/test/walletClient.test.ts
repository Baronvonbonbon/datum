// Unit tests for the popup-side walletClient.
//
// We mock chrome.runtime.sendMessage so each call goes through the
// real wire format (WALLET_RPC_REQUEST envelope), and the mock
// returns shaped WALLET_RPC_RESPONSE replies. This validates:
//   - the popup → background contract is consistent
//   - per-op argument passing
//   - error mapping (ok=false → rejected Promise)
//   - chrome.runtime.lastError surface

import type { WalletRpcResponse } from "../src/shared/messages";

type SendMessageHandler = (
  msg: any,
  cb: (reply: unknown) => void
) => void;

let mockSendMessage: jest.Mock;
let mockLastError: { message: string } | undefined;

beforeEach(() => {
  jest.resetModules();
  mockLastError = undefined;
  mockSendMessage = jest.fn((msg: any, cb?: (reply: unknown) => void) => {
    // Default reply: a successful empty payload. Tests override per-case.
    const reply: WalletRpcResponse = {
      type: "WALLET_RPC_RESPONSE",
      requestId: msg.requestId,
      ok: true,
      payload: undefined,
    };
    Promise.resolve().then(() => cb?.(reply));
  });

  (globalThis as any).chrome = {
    runtime: {
      sendMessage: mockSendMessage,
      get lastError() {
        return mockLastError;
      },
    },
  };
});

async function loadClient() {
  return import("../src/popup/wallet/walletClient");
}

function respondWith(payload: unknown, ok = true, error?: string) {
  mockSendMessage.mockImplementation((msg: any, cb?: (reply: unknown) => void) => {
    const reply: WalletRpcResponse = {
      type: "WALLET_RPC_RESPONSE",
      requestId: msg.requestId,
      ok,
      payload: ok ? payload : undefined,
      error: ok ? undefined : error,
    };
    Promise.resolve().then(() => cb?.(reply));
  });
}

// ─── Wire format tests ─────────────────────────────────────────────────

describe("walletClient envelope", () => {
  it("wraps each call in a WALLET_RPC_REQUEST with a unique requestId", async () => {
    const { walletClient } = await loadClient();
    respondWith({});
    await walletClient.lock();
    await walletClient.lock();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const id1 = mockSendMessage.mock.calls[0][0].requestId;
    const id2 = mockSendMessage.mock.calls[1][0].requestId;
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^popup-\d+-\d+$/);
  });

  it("passes args through under .args", async () => {
    const { walletClient } = await loadClient();
    respondWith({});
    await walletClient.createWallet({ password: "p", strength: 256 });
    const sent = mockSendMessage.mock.calls[0][0];
    expect(sent.type).toBe("WALLET_RPC_REQUEST");
    expect(sent.op).toBe("createWallet");
    expect(sent.args).toEqual({ password: "p", strength: 256 });
  });

  it("uses op name 'unlock' and bundles password", async () => {
    const { walletClient } = await loadClient();
    respondWith({});
    await walletClient.unlock("pw");
    expect(mockSendMessage.mock.calls[0][0].op).toBe("unlock");
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({ password: "pw" });
  });

  it("forwards label argument for addHdAccount", async () => {
    const { walletClient } = await loadClient();
    respondWith({});
    await walletClient.addHdAccount("Savings");
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({ label: "Savings" });
  });
});

// ─── Reply handling ────────────────────────────────────────────────────

describe("walletClient reply handling", () => {
  it("resolves with payload on ok=true", async () => {
    const { walletClient } = await loadClient();
    respondWith({ state: "unlocked", accounts: [], activeIndex: 0 });
    const result = await walletClient.lock();
    expect((result as any).state).toBe("unlocked");
  });

  it("rejects with error message on ok=false", async () => {
    const { walletClient } = await loadClient();
    respondWith(undefined, false, "bad-password");
    await expect(walletClient.unlock("wrong")).rejects.toThrow("bad-password");
  });

  it("rejects when chrome.runtime.lastError fires", async () => {
    const { walletClient } = await loadClient();
    mockSendMessage.mockImplementation((_msg: any, cb?: (reply: unknown) => void) => {
      mockLastError = { message: "extension reloaded" };
      Promise.resolve().then(() => {
        cb?.(undefined);
        mockLastError = undefined;
      });
    });
    await expect(walletClient.getStatus()).rejects.toThrow(
      "extension reloaded"
    );
  });

  it("rejects on malformed reply", async () => {
    const { walletClient } = await loadClient();
    mockSendMessage.mockImplementation((_msg: any, cb?: (reply: unknown) => void) => {
      Promise.resolve().then(() => cb?.({ type: "wrong" }));
    });
    await expect(walletClient.getStatus()).rejects.toThrow(/malformed/);
  });

  it("rejects with generic message when ok=false has no error string", async () => {
    const { walletClient } = await loadClient();
    respondWith(undefined, false);
    await expect(walletClient.getStatus()).rejects.toThrow(/failed/);
  });
});

// ─── Per-op coverage ───────────────────────────────────────────────────

describe("walletClient per-op", () => {
  it("getNativeBalance sends address arg", async () => {
    const { walletClient } = await loadClient();
    respondWith("0x100");
    const bal = await walletClient.getNativeBalance("0xabc");
    expect(bal).toBe("0x100");
    expect(mockSendMessage.mock.calls[0][0].op).toBe("getNativeBalance");
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({ address: "0xabc" });
  });

  it("sendNative forwards all tx fields", async () => {
    const { walletClient } = await loadClient();
    respondWith({ txHash: "0xabc", nonce: 5 });
    const r = await walletClient.sendNative({
      to: "0x0001",
      valueWei: "100",
      chainId: 1,
      gasLimit: 21000,
      maxFeePerGas: "10",
    });
    expect(r).toEqual({ txHash: "0xabc", nonce: 5 });
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({
      to: "0x0001",
      valueWei: "100",
      chainId: 1,
      gasLimit: 21000,
      maxFeePerGas: "10",
    });
  });

  it("setIdleTimeoutMinutes uses 'minutes' field", async () => {
    const { walletClient } = await loadClient();
    respondWith(undefined);
    await walletClient.setIdleTimeoutMinutes(15);
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({ minutes: 15 });
  });

  it("personalSign sends 'message' field", async () => {
    const { walletClient } = await loadClient();
    respondWith("0xsig");
    const sig = await walletClient.personalSign("hello");
    expect(sig).toBe("0xsig");
    expect(mockSendMessage.mock.calls[0][0].args).toEqual({ message: "hello" });
  });
});
