import RedisMock from "ioredis-mock";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCacheBackend } from "../src/cache/filesystem.js";
import { MemoryCacheBackend } from "../src/cache/memory.js";
import { RedisCacheBackend } from "../src/cache/redis.js";
import type { CacheBackend } from "../src/cache/types.js";

function contractTests(name: string, make: () => CacheBackend | Promise<CacheBackend>): void {
  describe(name, () => {
    it("returns null for missing keys", async () => {
      const cache = await make();
      expect(await cache.get("nope")).toBeNull();
      await cache.close();
    });

    it("stores and reads values", async () => {
      const cache = await make();
      await cache.set("k", "v", null);
      expect(await cache.get("k")).toBe("v");
      await cache.close();
    });

    it("expires entries after their TTL", async () => {
      const cache = await make();
      await cache.set("k", "v", 30);
      expect(await cache.get("k")).toBe("v");
      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.get("k")).toBeNull();
      await cache.close();
    });

    it("keeps entries without TTL until deleted", async () => {
      const cache = await make();
      await cache.set("k", "v", null);
      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.get("k")).toBe("v");
      await cache.delete("k");
      expect(await cache.get("k")).toBeNull();
      await cache.close();
    });
  });
}

contractTests("MemoryCacheBackend", () => new MemoryCacheBackend(1000));
contractTests(
  "RedisCacheBackend",
  // ioredis-mock is API-compatible; types differ, hence the cast.
  () => new RedisCacheBackend("redis://unused", "test:", new RedisMock() as never),
);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ethproxy-cache-test-"));
}

contractTests("FilesystemCacheBackend", async () => {
  // Sweep disabled: TTL handling is exercised by the contract itself, and the
  // sweep-specific behavior lives in filesystem-cache.test.ts.
  return new FilesystemCacheBackend(await tempDir(), { sweepIntervalMs: 0 });
});
