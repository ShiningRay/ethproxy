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

/**
 * Plain-text cache key for the reorg-validated methods (see RAW_KEY_METHODS
 * in cache-rules.ts): params are embedded in the clear — after normalization
 * — so external tooling can construct keys to read or invalidate entries
 * without replicating the hashing. `params` must already be normalized.
 */
export function rawCacheKey(method: string, normalizedParams: unknown[]): string {
  return `${method}:${stableStringify(normalizedParams)}`;
}

/**
 * Wrapper for number-keyed entries subject to read-time reorg validation:
 * the payload is stored alongside the height and the canonical block hash
 * observed at write time. On read, the hash is compared against the reorg
 * detector's header window; a mismatch means the entry's height was reorged
 * and the entry is stale.
 */
export interface ValidatedEntry {
  /** Block height the payload answers for. */
  h: number;
  /** Canonical hash at write time; null = unverifiable, trusted as-is. */
  b: string | null;
  /** The actual JSON-RPC result payload. */
  d: unknown;
}

export function wrapValidatedEntry(
  height: number,
  blockHash: string | null,
  payload: unknown,
): string {
  const entry: ValidatedEntry = { h: height, b: blockHash, d: payload };
  return JSON.stringify(entry);
}

/**
 * Parse a stored value as a ValidatedEntry, or null when it is a plain
 * (unwrapped) payload. Distinguishes by the {h, b, d} shape, which no plain
 * RPC payload carries.
 */
export function parseValidatedEntry(raw: string): ValidatedEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.h !== "number" || !("b" in obj) || !("d" in obj)) return null;
  if (obj.b !== null && typeof obj.b !== "string") return null;
  return { h: obj.h, b: obj.b, d: obj.d };
}

/** No-op backend used when caching is disabled: never stores, never connects anywhere. */
class NullCacheBackend implements CacheBackend {
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async close(): Promise<void> {}
}

export function createCacheBackend(config: CacheConfig): CacheBackend {
  if (!config.enabled) return new NullCacheBackend();
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

  async delete(key: string): Promise<void> {
    try {
      await this.backend.delete(key);
    } catch (err) {
      this.errors += 1;
      this.logger?.warn("cache delete failed", err);
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
