import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRpcEndpoint,
  setRpcEndpoint,
  resetRpcEndpoint,
  isOperatorRoute,
  pingRpcEndpoint,
  DEFAULT_RPC_ENDPOINT,
} from "../src/lib/rpcSettings";

describe("rpcSettings storage", () => {
  it("returns the default endpoint when nothing is persisted", () => {
    expect(getRpcEndpoint()).toBe(DEFAULT_RPC_ENDPOINT);
  });

  it("persists and reads back a custom endpoint", () => {
    setRpcEndpoint("https://my-archive.example/eth-rpc");
    expect(getRpcEndpoint()).toBe("https://my-archive.example/eth-rpc");
  });

  it("trims whitespace from the input", () => {
    setRpcEndpoint("  https://my-archive.example  ");
    expect(getRpcEndpoint()).toBe("https://my-archive.example");
  });

  it("rejects URLs that aren't http(s)", () => {
    expect(() => setRpcEndpoint("ws://nope")).toThrow();
    expect(() => setRpcEndpoint("ftp://nope")).toThrow();
    expect(() => setRpcEndpoint("not a url")).toThrow();
    // Default still wins.
    expect(getRpcEndpoint()).toBe(DEFAULT_RPC_ENDPOINT);
  });

  it("ignores a stored invalid URL and falls back to default", () => {
    localStorage.setItem("rpcEndpoint", "not a url");
    expect(getRpcEndpoint()).toBe(DEFAULT_RPC_ENDPOINT);
  });

  it("resetRpcEndpoint clears the persisted value", () => {
    setRpcEndpoint("https://my-archive.example");
    resetRpcEndpoint();
    expect(getRpcEndpoint()).toBe(DEFAULT_RPC_ENDPOINT);
  });
});

describe("isOperatorRoute", () => {
  it("matches /publisher and nested routes", () => {
    expect(isOperatorRoute("/publisher")).toBe(true);
    expect(isOperatorRoute("/publisher/")).toBe(true);
    expect(isOperatorRoute("/publisher/dashboard")).toBe(true);
    expect(isOperatorRoute("/publisher/stake/edit")).toBe(true);
  });

  it("matches /advertiser and nested routes", () => {
    expect(isOperatorRoute("/advertiser")).toBe(true);
    expect(isOperatorRoute("/advertiser/campaigns/42")).toBe(true);
  });

  it("matches /protocol", () => {
    expect(isOperatorRoute("/protocol")).toBe(true);
    expect(isOperatorRoute("/protocol/blocklist")).toBe(true);
  });

  it("matches case-insensitively (defense against URL casing tricks)", () => {
    expect(isOperatorRoute("/Publisher")).toBe(true);
    expect(isOperatorRoute("/ADVERTISER/campaigns")).toBe(true);
  });

  it("returns false for end-user routes", () => {
    expect(isOperatorRoute("/")).toBe(false);
    expect(isOperatorRoute("/explorer")).toBe(false);
    expect(isOperatorRoute("/me")).toBe(false);
    expect(isOperatorRoute("/me/identity")).toBe(false);
    expect(isOperatorRoute("/explorer/campaigns/123")).toBe(false);
  });

  it("rejects look-alike prefixes (no /publishers, /protocols)", () => {
    expect(isOperatorRoute("/publishers")).toBe(false);
    expect(isOperatorRoute("/protocols")).toBe(false);
    expect(isOperatorRoute("/publisher-archive")).toBe(false);
  });
});

describe("pingRpcEndpoint", () => {
  // We mock global fetch per-test. Vitest's `vi.stubGlobal` keeps
  // the stub scoped so it doesn't leak across files.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok=true + chainId on a healthy gateway", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "0x190f1b41" }),
    } as Response);
    const r = await pingRpcEndpoint("https://example.com/eth-rpc");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chainId).toBe("0x190f1b41");
  });

  it("returns ok=false with the RPC error message on a 200 + error JSON", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: "method not found" } }),
    } as Response);
    const r = await pingRpcEndpoint("https://example.com/eth-rpc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/method not found/);
  });

  it("returns ok=false on a non-2xx response", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const r = await pingRpcEndpoint("https://example.com/eth-rpc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/500/);
  });

  it("returns ok=false on a non-hex chainId", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "not a hex string" }),
    } as Response);
    const r = await pingRpcEndpoint("https://example.com/eth-rpc");
    expect(r.ok).toBe(false);
  });

  it("returns ok=false on fetch rejection (DNS, CORS, etc.)", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockRejectedValueOnce(new Error("DNS lookup failed"));
    const r = await pingRpcEndpoint("https://no-such-host.example/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/DNS/i);
  });

  it("rejects without calling fetch when the URL isn't http(s)", async () => {
    const fetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const r = await pingRpcEndpoint("ws://example.com");
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
