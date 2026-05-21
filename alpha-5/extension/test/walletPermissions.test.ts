// Unit tests for background/wallet/permissions + permissionQueue +
// providerHandler. We mock chrome.storage.local via a fresh in-memory
// store per test, and stub the wallet/pine modules the providerHandler
// reaches into so this file stays self-contained.

import "./chromeMock";
import { resetStore, seedStore } from "./chromeMock";

import {
  listPermissions,
  isPermitted,
  grantPermission,
  revokePermission,
  clearAllPermissions,
  normalizeOrigin,
} from "../src/background/wallet/permissions";
import {
  enqueue,
  peekQueue,
  approve,
  deny,
  denyAll,
  __test as queueTest,
} from "../src/background/wallet/permissionQueue";

beforeEach(() => {
  resetStore();
  queueTest.reset();
});

// ─── permissions.ts ────────────────────────────────────────────────

describe("permissions store", () => {
  it("listPermissions returns [] when storage is empty", async () => {
    expect(await listPermissions()).toEqual([]);
  });

  it("grant then list returns the granted origin", async () => {
    await grantPermission("https://example.com", "0xABCD");
    const perms = await listPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].origin).toBe("https://example.com");
    expect(perms[0].grantedForAccount).toBe("0xabcd");
  });

  it("grant lowercases the origin and the account", async () => {
    await grantPermission("HTTPS://Example.COM", "0xABCD");
    const perms = await listPermissions();
    expect(perms[0].origin).toBe("https://example.com");
    expect(perms[0].grantedForAccount).toBe("0xabcd");
  });

  it("isPermitted returns true for granted origin, false otherwise", async () => {
    await grantPermission("https://example.com", "0xabc");
    expect(await isPermitted("https://example.com")).toBe(true);
    expect(await isPermitted("https://EXAMPLE.com")).toBe(true);
    expect(await isPermitted("https://other.com")).toBe(false);
  });

  it("re-granting updates grantedAt but doesn't duplicate", async () => {
    await grantPermission("https://example.com", "0xa");
    const first = (await listPermissions())[0];
    await new Promise((r) => setTimeout(r, 5));
    await grantPermission("https://example.com", "0xb");
    const perms = await listPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].grantedAt).toBeGreaterThan(first.grantedAt);
    expect(perms[0].grantedForAccount).toBe("0xb");
  });

  it("revokePermission removes the entry; idempotent for unknown origins", async () => {
    await grantPermission("https://example.com", "0xa");
    await revokePermission("https://example.com");
    expect(await listPermissions()).toEqual([]);
    await expect(revokePermission("https://nope.com")).resolves.toBeUndefined();
  });

  it("clearAllPermissions wipes storage", async () => {
    await grantPermission("https://a.com", "0xa");
    await grantPermission("https://b.com", "0xb");
    await clearAllPermissions();
    expect(await listPermissions()).toEqual([]);
  });

  it("listPermissions sorts newest-first", async () => {
    await grantPermission("https://a.com", "0x1");
    await new Promise((r) => setTimeout(r, 5));
    await grantPermission("https://b.com", "0x2");
    const perms = await listPermissions();
    expect(perms[0].origin).toBe("https://b.com");
    expect(perms[1].origin).toBe("https://a.com");
  });

  it("listPermissions filters malformed entries from storage", async () => {
    seedStore({
      walletPermissions: [
        { origin: "https://good.com", grantedAt: 1, grantedForAccount: "0xa" },
        { totallyDifferent: true },
        null,
        { origin: 42 },
      ],
    });
    const perms = await listPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].origin).toBe("https://good.com");
  });
});

describe("normalizeOrigin", () => {
  it("returns the canonical lowercase origin for http(s)", () => {
    expect(normalizeOrigin("HTTPS://Example.COM/some/path?x=1")).toBe(
      "https://example.com"
    );
    expect(normalizeOrigin("http://example.com:8080")).toBe(
      "http://example.com:8080"
    );
  });

  it("rejects non-http schemes", () => {
    expect(normalizeOrigin("chrome-extension://abc")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("ws://example.com")).toBeNull();
  });

  it("rejects invalid URLs", () => {
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

// ─── permissionQueue.ts ────────────────────────────────────────────

describe("permission queue", () => {
  it("enqueue parks a promise; approve resolves with 'approved'", async () => {
    const p = enqueue("https://example.com");
    const queue = peekQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].origin).toBe("https://example.com");
    expect(approve(queue[0].id)).toBe(true);
    expect(await p).toBe("approved");
    expect(peekQueue()).toHaveLength(0);
  });

  it("deny resolves with 'denied'", async () => {
    const p = enqueue("https://example.com");
    const id = peekQueue()[0].id;
    expect(deny(id)).toBe(true);
    expect(await p).toBe("denied");
  });

  it("approve/deny for unknown id returns false", () => {
    expect(approve("nope")).toBe(false);
    expect(deny("nope")).toBe(false);
  });

  it("denyAll resolves every queued promise with 'denied' and reports the count", async () => {
    const a = enqueue("https://a.com");
    const b = enqueue("https://b.com");
    expect(denyAll()).toBe(2);
    expect(await a).toBe("denied");
    expect(await b).toBe("denied");
    expect(peekQueue()).toEqual([]);
  });

  it("timeout fires after 60s without approve/deny", async () => {
    jest.useFakeTimers();
    try {
      const p = enqueue("https://example.com");
      // Park while we advance the timer; sleep yields to the promise
      // microtask queue without leaving fake-time mode.
      jest.advanceTimersByTime(60_001);
      expect(await p).toBe("timed-out");
      expect(peekQueue()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("queue length is reflected in peekQueue snapshots", async () => {
    enqueue("https://a.com");
    enqueue("https://b.com");
    enqueue("https://c.com");
    expect(peekQueue()).toHaveLength(3);
    expect(peekQueue().map((p) => p.origin)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
    denyAll();
  });
});

// ─── providerHandler.ts ────────────────────────────────────────────

describe("providerHandler", () => {
  // The handler reaches into unlock.getStatus, pineRpc, and the
  // signing module. We isolate it via module mocks.

  beforeEach(() => {
    jest.resetModules();
    resetStore();
    queueTest.reset();
  });

  async function loadHandler(stubs: {
    walletState?: "no-vault" | "locked" | "unlocked";
    activeAddress?: string;
    pineImpl?: (method: string, params: unknown[]) => Promise<unknown>;
    signingImpls?: {
      signTransaction?: jest.Mock;
      signTypedData?: jest.Mock;
      personalSign?: jest.Mock;
    };
  }) {
    const state = stubs.walletState ?? "unlocked";
    const addr = stubs.activeAddress ?? "0x0000000000000000000000000000000000000123";
    jest.doMock("../src/background/wallet/unlock", () => ({
      getStatus: jest.fn(async () => ({
        state,
        accounts: [],
        activeIndex: 0,
        activeAddress: state === "unlocked" ? addr : "",
        msUntilAutoLock: null,
      })),
    }));
    jest.doMock("../src/background/pineBridge", () => ({
      pineRpc: jest.fn(stubs.pineImpl ?? (async () => "0x1")),
    }));
    jest.doMock("../src/background/wallet/signing", () => ({
      signTransaction: stubs.signingImpls?.signTransaction ?? jest.fn(async () => "0xrawtx"),
      signTypedData: stubs.signingImpls?.signTypedData ?? jest.fn(async () => "0xtypedsig"),
      personalSign: stubs.signingImpls?.personalSign ?? jest.fn(async () => "0xpersonalsig"),
    }));
    const mod = await import("../src/background/wallet/providerHandler");
    // After jest.resetModules, the providerHandler module above pulls
    // a FRESH copy of permissionQueue (its singleton state is
    // independent from the top-level imports). Return the same fresh
    // instance so tests can peek/approve/deny on the right queue.
    const queue = await import("../src/background/wallet/permissionQueue");
    return { ...mod, queue };
  }

  it("eth_chainId is free (no permission needed)", async () => {
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_chainId",
      params: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("0x190f1b41");
  });

  it("net_version returns decimal chainId", async () => {
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "net_version",
      params: [],
    });
    if (r.ok) expect(r.result).toBe("420420417");
  });

  it("eth_accounts on unpermitted origin returns []", async () => {
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://nope.com",
      method: "eth_accounts",
      params: [],
    });
    if (r.ok) expect(r.result).toEqual([]);
  });

  it("eth_accounts on permitted origin returns active address", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
    });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_accounts",
      params: [],
    });
    if (r.ok) {
      expect(r.result).toEqual(["0xabc0000000000000000000000000000000000000"]);
    }
  });

  it("read RPC on unpermitted origin returns 4100", async () => {
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://nope.com",
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4100);
  });

  it("read RPC on permitted origin passes through to pine", async () => {
    await grantPermission("https://example.com", "0xabc");
    const pineImpl = jest.fn(async () => "0x42");
    const { handleProviderRequest } = await loadHandler({ pineImpl });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    });
    if (r.ok) expect(r.result).toBe("0x42");
    expect(pineImpl).toHaveBeenCalledWith("eth_getBalance", ["0xabc", "latest"]);
  });

  it("signing methods require unlocked wallet", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({ walletState: "locked" });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "personal_sign",
      params: ["hello", "0xabc"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4100);
  });

  it("personal_sign decodes 0x-hex messages before signing", async () => {
    await grantPermission("https://example.com", "0xabc");
    const personalSign = jest.fn(async () => "0xsig");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
      signingImpls: { personalSign },
    });
    // "hi" = 0x6869
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "personal_sign",
      params: ["0x6869", "0xabc0000000000000000000000000000000000000"],
    });
    expect(r.ok).toBe(true);
    expect(personalSign).toHaveBeenCalledWith("hi");
  });

  it("personal_sign rejects when requested addr differs from active", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0x1111111111111111111111111111111111111111",
    });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "personal_sign",
      params: ["hello", "0x2222222222222222222222222222222222222222"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4100);
  });

  it("eth_sendTransaction signs + broadcasts via pine", async () => {
    await grantPermission("https://example.com", "0xabc");
    const pineImpl = jest.fn(async (method: string) => {
      if (method === "eth_sendRawTransaction") return "0xhash";
      return "0x0";
    });
    const signTransaction = jest.fn(async () => "0xrawtx");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
      pineImpl,
      signingImpls: { signTransaction },
    });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_sendTransaction",
      params: [{ to: "0x123", value: "0x1" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("0xhash");
    expect(signTransaction).toHaveBeenCalled();
    expect(pineImpl).toHaveBeenCalledWith("eth_sendRawTransaction", ["0xrawtx"]);
  });

  it("eth_requestAccounts on already-permitted origin returns immediately", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
    });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_requestAccounts",
      params: [],
    });
    if (r.ok) {
      expect(r.result).toEqual(["0xabc0000000000000000000000000000000000000"]);
    }
  });

  it("eth_requestAccounts on new origin queues + waits for approve", async () => {
    const { handleProviderRequest, queue } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
    });
    const reqPromise = handleProviderRequest({
      origin: "https://new.com",
      method: "eth_requestAccounts",
      params: [],
    });
    // Give the promise a tick to push into the queue.
    await new Promise((r) => setTimeout(r, 5));
    const queued = queue.peekQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].origin).toBe("https://new.com");
    queue.approve(queued[0].id);
    const r = await reqPromise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toEqual(["0xabc0000000000000000000000000000000000000"]);
    }
    // Approval should have persisted the grant.
    expect(await isPermitted("https://new.com")).toBe(true);
  });

  it("eth_requestAccounts deny returns 4001 User Rejected", async () => {
    const { handleProviderRequest, queue } = await loadHandler({});
    const reqPromise = handleProviderRequest({
      origin: "https://new.com",
      method: "eth_requestAccounts",
      params: [],
    });
    await new Promise((r) => setTimeout(r, 5));
    const queued = queue.peekQueue();
    queue.deny(queued[0].id);
    const r = await reqPromise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4001);
    expect(await isPermitted("https://new.com")).toBe(false);
  });

  it("eth_requestAccounts on no-vault returns 4900", async () => {
    const { handleProviderRequest } = await loadHandler({ walletState: "no-vault" });
    const r = await handleProviderRequest({
      origin: "https://new.com",
      method: "eth_requestAccounts",
      params: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4900);
  });

  it("wallet_switchEthereumChain returns 4902 (Paseo-only)", async () => {
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4902);
  });

  it("unknown methods return 4200 Unsupported", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({});
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "weird_method",
      params: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4200);
  });

  it("eth_sign returns 4200 (deprecated)", async () => {
    await grantPermission("https://example.com", "0xabc");
    const { handleProviderRequest } = await loadHandler({
      activeAddress: "0xabc0000000000000000000000000000000000000",
    });
    const r = await handleProviderRequest({
      origin: "https://example.com",
      method: "eth_sign",
      params: ["0xabc", "0xdata"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(4200);
  });
});
