// Tests for background/wallet/providerEvents.ts.
//
// Mocks chrome.tabs.query + sendMessage so we can assert the
// broadcast filter logic without a real browser environment.

import "./chromeMock";
import { resetStore } from "./chromeMock";
import { grantPermission } from "../src/background/wallet/permissions";

type TabsApi = {
  query: jest.Mock;
  sendMessage: jest.Mock;
};

function installTabsMock(): TabsApi {
  const query = jest.fn();
  const sendMessage = jest.fn(async () => undefined);
  (globalThis as any).chrome.tabs = { query, sendMessage };
  return { query, sendMessage };
}

beforeEach(() => {
  resetStore();
});

describe("providerEvents.broadcastProviderEvent", () => {
  it("sends PROVIDER_EVENT only to tabs whose origin is permitted", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 1, url: "https://allowed.example/page1" },
      { id: 2, url: "https://other.example/page2" },
      { id: 3, url: "https://allowed.example/page3?q=x" },
    ]);

    const { broadcastProviderEvent } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastProviderEvent("accountsChanged", ["0xabc"]);

    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    const tabIds = tabs.sendMessage.mock.calls.map((c) => c[0]);
    expect(new Set(tabIds)).toEqual(new Set([1, 3]));
    const payload = tabs.sendMessage.mock.calls[0][1];
    expect(payload).toEqual({
      type: "PROVIDER_EVENT",
      event: "accountsChanged",
      data: ["0xabc"],
    });
  });

  it("skips tabs with no id (devtools, hidden) and tabs with non-http URLs", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { url: "https://allowed.example/x" }, // no id
      { id: 5, url: "chrome://settings" },
      { id: 6, url: "file:///tmp/something" },
      { id: 7, url: "https://allowed.example/y" },
    ]);

    const { broadcastProviderEvent } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastProviderEvent("chainChanged", "0x190f1b41");

    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(tabs.sendMessage.mock.calls[0][0]).toBe(7);
  });

  it("uses tab.pendingUrl when url isn't set yet (mid-navigation)", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 9, pendingUrl: "https://allowed.example/loading" },
    ]);

    const { broadcastProviderEvent } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastProviderEvent("accountsChanged", []);

    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(tabs.sendMessage.mock.calls[0][0]).toBe(9);
  });

  it("swallows sendMessage errors per-tab so one bad tab doesn't kill the broadcast", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 1, url: "https://allowed.example/a" },
      { id: 2, url: "https://allowed.example/b" },
    ]);
    tabs.sendMessage.mockImplementation(async (tabId: number) => {
      if (tabId === 1) throw new Error("no listener");
      return undefined;
    });

    const { broadcastProviderEvent } = await import(
      "../src/background/wallet/providerEvents"
    );
    // Should NOT reject.
    await expect(
      broadcastProviderEvent("accountsChanged", ["0xabc"])
    ).resolves.toBeUndefined();
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("handles tabs.query failures gracefully (logs + returns)", async () => {
    const tabs = installTabsMock();
    tabs.query.mockRejectedValueOnce(new Error("query forbidden"));

    const { broadcastProviderEvent } = await import(
      "../src/background/wallet/providerEvents"
    );
    await expect(
      broadcastProviderEvent("accountsChanged", [])
    ).resolves.toBeUndefined();
    expect(tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe("providerEvents convenience helpers", () => {
  it("broadcastAccountsChanged sends EIP-1193-shaped payload", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 1, url: "https://allowed.example/x" },
    ]);
    const { broadcastAccountsChanged } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastAccountsChanged(["0xabc"]);
    expect(tabs.sendMessage.mock.calls[0][1].event).toBe("accountsChanged");
    expect(tabs.sendMessage.mock.calls[0][1].data).toEqual(["0xabc"]);
  });

  it("broadcastConnect wraps chainId in EIP-1193 connect payload", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 1, url: "https://allowed.example/x" },
    ]);
    const { broadcastConnect } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastConnect("0x190f1b41");
    expect(tabs.sendMessage.mock.calls[0][1].event).toBe("connect");
    expect(tabs.sendMessage.mock.calls[0][1].data).toEqual({
      chainId: "0x190f1b41",
    });
  });

  it("broadcastDisconnect uses code 4900 + message", async () => {
    await grantPermission("https://allowed.example", "0xabc");
    const tabs = installTabsMock();
    tabs.query.mockResolvedValueOnce([
      { id: 1, url: "https://allowed.example/x" },
    ]);
    const { broadcastDisconnect } = await import(
      "../src/background/wallet/providerEvents"
    );
    await broadcastDisconnect("Wallet locked");
    expect(tabs.sendMessage.mock.calls[0][1].event).toBe("disconnect");
    expect(tabs.sendMessage.mock.calls[0][1].data).toEqual({
      code: 4900,
      message: "Wallet locked",
    });
  });
});
