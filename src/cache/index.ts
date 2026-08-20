import { createHash } from "node:crypto";
import type { CacheConfig } from "../config.js";
import { stableStringify } from "../rpc.js";
import { MemoryCacheBackend } from "./memory.js";
import { RedisCacheBackend } from "./redis.js";
import type { CacheBackend } from "./types.js";

export type { CacheBackend } from "./types.js";

/** Deterministic cache key for a JSON-RPC call. */
export function cacheKey(method: string, params: unknown[]): string {
  const digest = createHash("sha256")
    .update(method)
    .update("\n")
    .update(stableStringify(params))
    .digest("hex");
  return `${method}:${digest}`;
}

export function createCacheBackend(config: CacheConfig): CacheBackend {
  switch (config.backend) {
    case "memory":
      return new MemoryCacheBackend(config.memory.maxEntries);
    case "redis":
      return new RedisCacheBackend(
        config.redis?.url ?? "redis://127.0.0.1:6379",
        config.redis?.keyPrefix ?? "ethproxy:",
      );
  }
}

export interface LoggerLike {
  warn: (msg: string, err?: unknown) => void;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  errors: number;
  hitRate: number;
}

/**
 * Wraps a backend so storage failures degrade to cache misses instead of
 * breaking proxied requests (e.g. Redis temporarily unreachable).
 * Also keeps simple hit/miss counters for observability.
 */
export class ResponseCache {
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private errors = 0;

  constructor(
    private readonly backend: CacheBackend,
    private readonly logger?: LoggerLike,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.backend.get(key);
      if (value === null) {
        this.misses += 1;
      } else {
        this.hits += 1;
      }
      return value;
    } catch (err) {
      this.errors += 1;
      this.misses += 1;
      this.logger?.warn("cache get failed, treating as miss", err);
      return null;
    }
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    try {
      await this.backend.set(key, value, ttlMs);
      this.sets += 1;
    } catch (err) {
      this.errors += 1;
      this.logger?.warn("cache set failed, entry skipped", err);
    }
  }

  stats(): CacheStats {
    const lookups = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      errors: this.errors,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
    };
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
