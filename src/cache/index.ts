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

/**
 * Wraps a backend so storage failures degrade to cache misses instead of
 * breaking proxied requests (e.g. Redis temporarily unreachable).
 */
export class ResponseCache {
  constructor(
    private readonly backend: CacheBackend,
    private readonly logger?: LoggerLike,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.backend.get(key);
    } catch (err) {
      this.logger?.warn("cache get failed, treating as miss", err);
      return null;
    }
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    try {
      await this.backend.set(key, value, ttlMs);
    } catch (err) {
      this.logger?.warn("cache set failed, entry skipped", err);
    }
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
