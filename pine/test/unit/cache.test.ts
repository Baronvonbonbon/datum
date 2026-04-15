import { describe, it, expect, vi } from "vitest";
import { Cache } from "../../src/cache/Cache.js";

describe("Cache", () => {
  it("stores and retrieves values", () => {
    const cache = new Cache();
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("returns undefined for missing keys", () => {
    const cache = new Cache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new Cache(100, 50); // 50ms default TTL
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");

    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    expect(cache.get("key")).toBeUndefined();
    vi.useRealTimers();
  });

  it("respects custom TTL per entry", () => {
    vi.useFakeTimers();
    const cache = new Cache(100, 10_000);
    cache.set("short", "val", 50);
    cache.set("long", "val", 5_000);

    vi.advanceTimersByTime(100);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("val");
    vi.useRealTimers();
  });

  it("invalidates by prefix", () => {
    const cache = new Cache();
    cache.set("state:balance:0x1", "100");
    cache.set("state:nonce:0x1", "5");
    cache.set("call:0x1:0xaabb", "result");

    cache.invalidateByPrefix("state:");
    expect(cache.get("state:balance:0x1")).toBeUndefined();
    expect(cache.get("state:nonce:0x1")).toBeUndefined();
    expect(cache.get("call:0x1:0xaabb")).toBe("result");
  });

  it("evicts LRU when max entries reached", () => {
    vi.useFakeTimers();
    const cache = new Cache(3, 60_000);

    vi.setSystemTime(1000);
    cache.set("a", 1);
    vi.setSystemTime(2000);
    cache.set("b", 2);
    vi.setSystemTime(3000);
    cache.set("c", 3);

    // Access "a" to make it most recently used
    vi.setSystemTime(4000);
    cache.get("a");

    // Adding "d" should evict "b" (oldest accessedAt = 2000)
    vi.setSystemTime(5000);
    cache.set("d", 4);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
    vi.useRealTimers();
  });

  it("clears all entries", () => {
    const cache = new Cache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("deletes specific entries", () => {
    const cache = new Cache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });
});
