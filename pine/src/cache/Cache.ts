// ── TTL-based cache with LRU eviction ──

import type { CacheInterface } from "../types.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessedAt: number;
}

const DEFAULT_TTL_MS = 6_000; // One block (~6s)
const DEFAULT_MAX_ENTRIES = 1024;

export class Cache implements CacheInterface {
  private store = new Map<string, CacheEntry<unknown>>();
  private maxEntries: number;
  private defaultTtlMs: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, defaultTtlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    entry.accessedAt = Date.now();
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxEntries) {
      this.evictLRU();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
      accessedAt: Date.now(),
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Invalidate all keys with a given prefix (e.g. "state:" on new block) */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    const now = Date.now();

    for (const [key, entry] of this.store) {
      // Evict expired entries first
      if (now > entry.expiresAt) {
        this.store.delete(key);
        return;
      }
      if (entry.accessedAt < oldestAccess) {
        oldestAccess = entry.accessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.store.delete(oldestKey);
    }
  }
}
