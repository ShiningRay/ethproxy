import { LRUCache } from "lru-cache";
import type { CacheBackend } from "./types.js";

export class MemoryCacheBackend implements CacheBackend {
  private readonly cache: LRUCache<string, string>;

  constructor(maxEntries: number) {
    this.cache = new LRUCache<string, string>({ max: maxEntries });
  }

  async get(key: string): Promise<string | null> {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    // lru-cache treats ttl: 0 as "no expiry" but rejects undefined per-item
    // overrides only when a global ttl is set; Infinity is explicit and clear.
    this.cache.set(key, value, { ttl: ttlMs === null ? Infinity : ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async close(): Promise<void> {
    this.cache.clear();
  }
}
