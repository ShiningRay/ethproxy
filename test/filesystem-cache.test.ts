import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCacheBackend } from "../src/cache/filesystem.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ethproxy-fs-cache-"));
}

function make(dir: string, opts: Partial<ConstructorParameters<typeof FilesystemCacheBackend>[1]> = {}) {
  return new FilesystemCacheBackend(dir, { sweepIntervalMs: 0, ...opts });
}

describe("FilesystemCacheBackend", () => {
  it("persists entries across backend instances", async () => {
    const dir = await tempDir();
    const first = make(dir);
    await first.set("eth_blockNumber:abc", '{"e":null,"v":1}', null);
    await first.close();

    const second = make(dir);
    expect(await second.get("eth_blockNumber:abc")).toBe('{"e":null,"v":1}');
    await second.close();
  });

  it("stores files under hex shard directories with safe names", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    // Plain-text reorg-validated keys contain JSON punctuation and colons.
    const hostileKey = 'eth_getBlockByNumber:["0x1",false]"{}:\\/*';
    await cache.set(hostileKey, "v", null);
    expect(await cache.get(hostileKey)).toBe("v");

    const shards = await readdir(dir);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatch(/^[0-9a-f]{2}$/);
    const files = await readdir(join(dir, shards[0]!));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/);
    await cache.close();
  });

  it("sweep removes expired and corrupt files, keeps live ones", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("expired", "v", 10);
    await cache.set("live", "v", 60000);
    await cache.set("permanent", "v", null);
    const expiredPath = cache.pathForKey("expired");
    await new Promise((r) => setTimeout(r, 30));

    // Overwrite the permanent entry's file with garbage to simulate corruption.
    await writeFile(cache.pathForKey("permanent"), "not json", "utf8");

    await cache.sweep();
    await expect(readFile(expiredPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cache.get("live")).toBe("v");
    expect(await cache.get("permanent")).toBeNull(); // corrupt -> miss
    await cache.close();
  });

  it("sweep enforces maxBytes, evicting oldest-written files first", async () => {
    const dir = await tempDir();
    // Each envelope for value "v" is exactly 15 bytes ('{"e":null,"v":"v"}'),
    // so a 20-byte budget fits one entry but not two.
    const cache = make(dir, { maxBytes: 20 });
    await cache.set("old", "v", null);
    // Distinct mtimes: same-ms writes would make eviction order ambiguous.
    await new Promise((r) => setTimeout(r, 20));
    await cache.set("new", "v", null);

    await cache.sweep();
    expect(await cache.get("old")).toBeNull();
    expect(await cache.get("new")).toBe("v");
    await cache.close();
  });

  it("replaces the old file when a key is rewritten with a new TTL", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("k", "v1", null);
    await cache.set("k", "v2", 60000);
    expect(await cache.get("k")).toBe("v2");
    await cache.close();

    // No orphaned temp files or stale duplicates left behind.
    const shards = await readdir(dir);
    const files: string[] = [];
    for (const shard of shards) {
      files.push(...(await readdir(join(dir, shard))));
    }
    expect(files).toHaveLength(1);
  });

  it("disabled sweep still serves entries (lazy expiry only)", async () => {
    const dir = await tempDir();
    const cache = make(dir, { sweepIntervalMs: 0 });
    await cache.set("k", "v", 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(await cache.get("k")).toBeNull();
    await cache.close();
  });
});
