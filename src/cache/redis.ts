import { Redis } from "ioredis";
import type { CacheBackend } from "./types.js";

export class RedisCacheBackend implements CacheBackend {
  private readonly client: Redis;
  private readonly keyPrefix: string;

  /**
   * Accepts an optional pre-built client so tests can inject ioredis-mock
   * without changing production behavior.
   */
  constructor(url: string, keyPrefix = "ethproxy:", client?: Redis) {
    this.client = client ?? new Redis(url, { lazyConnect: false });
    this.keyPrefix = keyPrefix;
  }

  private prefixed(key: string): string {
    return this.keyPrefix + key;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefixed(key));
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    if (ttlMs === null) {
      await this.client.set(this.prefixed(key), value);
    } else {
      await this.client.set(this.prefixed(key), value, "PX", ttlMs);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefixed(key));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
