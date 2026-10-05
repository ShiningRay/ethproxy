import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FilesystemCacheBackend } from "../src/cache/filesystem.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ethproxy-fs-cache-"));
}

function make(
  dir: string,
  opts: Partial<ConstructorParameters<typeof FilesystemCacheBackend>[1]> = {},
) {
  return new FilesystemCacheBackend(dir, {
    sweepIntervalMs: 0,
    inlineTtlMs: 0, // disk-only by default: the inline tier has its own tests
    ...opts,
  });
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Every file in the cache tree, relative to the root. */
async function allFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (sub: string): Promise<void> => {
    const entries = await readdir(join(dir, sub), { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(sub, e.name));
      else files.push(join(sub, e.name));
    }
  };
  await walk("");
  return files.sort();
}

describe("FilesystemCacheBackend", () => {
  it("persists permanent entries across backend instances", async () => {
    const dir = await tempDir();
    const first = make(dir);
    await first.set("eth_blockNumber:abc", '{"v":1}', null);
    await first.close();

    const second = make(dir);
    expect(await second.get("eth_blockNumber:abc")).toBe('{"v":1}');
    await second.close();
  });

  it("persists expiring entries across backend instances (index rebuilt from disk)", async () => {
    const dir = await tempDir();
    const first = make(dir);
    await first.set("k", "v", 60000);
    expect(await first.get("k")).toBe("v");
    await first.close();

    const second = make(dir); // fresh bucketIndex, rebuilt by bootstrap
    expect(await second.get("k")).toBe("v");
    await second.close();
  });

  it("stores permanent files under p/ with safe names", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    // Plain-text reorg-validated keys contain JSON punctuation and colons.
    const hostileKey = 'eth_getBlockByNumber:["0x1",false]"{}:\\/*';
    await cache.set(hostileKey, "v", null);
    expect(await cache.get(hostileKey)).toBe("v");

    const d = digest(hostileKey);
    const shard = d.slice(0, 2);
    const files = await allFiles(dir);
    expect(files).toEqual([join("p", shard, d)]);
    await cache.close();
  });

  it("stores expiring files in time buckets", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("k", "v", 60000);

    const d = digest("k");
    const files = await allFiles(dir);
    expect(files).toHaveLength(1);
    const [tDir, bucket, file] = files[0]!.split("/");
    expect(tDir).toBe("t");
    expect(Number(bucket)).toBeGreaterThan(0);
    expect(file).toBe(d);
    await cache.close();
  });

  it("sweep removes whole expired buckets without reading files", async () => {
    const dir = await tempDir();
    const cache = make(dir, { bucketMs: 100 });
    await cache.set("k", "v", 250); // expires inside bucket now/100 + 2 or 3
    expect(await cache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 400)); // entry expired, bucket passed

    await cache.sweep();
    expect(await allFiles(dir)).toEqual([]);
    expect(await cache.get("k")).toBeNull();
    await cache.close();
  });

  it("get lazily drops expired bucketed entries before any sweep", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("k", "v", 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(await cache.get("k")).toBeNull();
    await cache.close();
  });

  it("sweep removes corrupt permanent files, keeps live ones", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("permanent", "v", null);
    await new Promise((r) => setTimeout(r, 20));
    // Overwrite the permanent entry's file with garbage to simulate corruption.
    await writeFile(cache.pathForKey("permanent"), "not json", "utf8");

    await cache.sweep();
    expect(await cache.get("permanent")).toBeNull(); // corrupt -> miss
    await cache.close();
  });

  it("sweep enforces maxBytes, evicting oldest buckets and files first", async () => {
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

  it("sweep evicts whole oldest buckets when over budget", async () => {
    const dir = await tempDir();
    const cache = make(dir, { maxBytes: 20 });
    await cache.set("bucketed", "v", 60000); // one file in some bucket
    await new Promise((r) => setTimeout(r, 20));
    await cache.set("permanent", "v", null); // one file under p/

    await cache.sweep(); // 30 bytes > 20: the oldest bucket goes first
    expect(await cache.get("bucketed")).toBeNull();
    expect(await cache.get("permanent")).toBe("v");
    await cache.close();
  });

  it("replaces the old file when a key is rewritten across tiers", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("k", "v1", null); // p/
    await cache.set("k", "v2", 60000); // t/<bucket>/ (inline tier disabled)
    expect(await cache.get("k")).toBe("v2");
    await cache.close();

    // No orphaned temp files or stale duplicates left behind.
    expect(await allFiles(dir)).toHaveLength(1);
  });

  it("moving an entry back to permanent removes the stale bucketed copy", async () => {
    const dir = await tempDir();
    const cache = make(dir);
    await cache.set("k", "v1", 60000);
    await cache.set("k", "v2", null);
    await cache.close();

    const second = make(dir);
    expect(await second.get("k")).toBe("v2");
    expect(await allFiles(dir)).toHaveLength(1);
    await second.close();
  });

  it("disabled sweep still serves entries (lazy expiry only)", async () => {
    const dir = await tempDir();
    const cache = make(dir, { sweepIntervalMs: 0 });
    await cache.set("k", "v", 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(await cache.get("k")).toBeNull();
    await cache.close();
  });

  it("migrates the legacy shard layout at startup", async () => {
    const dir = await tempDir();
    const d = digest("legacy");
    const shardDir = join(dir, d.slice(0, 2));
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      join(shardDir, d),
      JSON.stringify({ e: null, v: "migrated" }),
      "utf8",
    );
    // Garbage from a crash mid-write: dropped during migration.
    await writeFile(join(shardDir, `${d}.1234.tmp`), '{"e":null,"v":"x"}', "utf8");
    // An already-expired legacy entry: dropped.
    await writeFile(
      join(shardDir, digest("stale")),
      JSON.stringify({ e: Date.now() - 1000, v: "old" }),
      "utf8",
    );

    const cache = make(dir);
    expect(await cache.get("legacy")).toBe("migrated");
    expect(await cache.get("stale")).toBeNull();
    // The legacy shard directory is gone; the file now lives under p/.
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["p", "t"]);
    await expect(readFile(join(dir, d.slice(0, 2), d), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cache.close();
  });

  it("migrates legacy expiring entries into time buckets", async () => {
    const dir = await tempDir();
    const d = digest("legacy-ttl");
    const shardDir = join(dir, d.slice(0, 2));
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      join(shardDir, d),
      JSON.stringify({ e: Date.now() + 60000, v: "alive" }),
      "utf8",
    );

    const cache = make(dir);
    expect(await cache.get("legacy-ttl")).toBe("alive");
    await cache.close();
  });
});

describe("FilesystemCacheBackend inline tier", () => {
  it("keeps short-TTL entries out of the cache directory", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("k", "v", 1000);
    expect(await cache.get("k")).toBe("v");
    expect(await allFiles(dir)).toEqual([]);
    await cache.close();
  });

  it("expires inline entries by their ttl", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("k", "v", 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(await cache.get("k")).toBeNull();
    await cache.close();
  });

  it("bounds the inline tier at inlineMaxEntries", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000, inlineMaxEntries: 2 });
    await cache.set("a", "1", 60000);
    await cache.set("b", "2", 60000);
    await cache.set("c", "3", 60000); // evicts "a" (LRU)
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("c")).toBe("3");
    await cache.close();
  });

  it("never inlines permanent entries", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("k", "v", null);
    expect(await allFiles(dir)).toHaveLength(1); // went to p/
    await cache.close();
  });

  it("a later permanent write drops the stale inline copy", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("k", "pending", 1000); // inline (tx not yet mined)
    await cache.set("k", "mined", null); // permanent (tx mined)
    expect(await cache.get("k")).toBe("mined");
    await cache.close();

    const second = make(dir);
    expect(await second.get("k")).toBe("mined"); // survived on disk
    await second.close();
  });

  it("a later short-TTL write drops the stale on-disk copy", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("k", "old", null); // p/
    await cache.set("k", "fresh", 1000); // inline now; disk copy must go
    await cache.close();

    const second = make(dir); // inline tier is gone with the process
    expect(await second.get("k")).toBeNull(); // no stale "old" resurfacing
    await second.close();
  });

  it("delete removes inline and on-disk copies", async () => {
    const dir = await tempDir();
    const cache = make(dir, { inlineTtlMs: 60000 });
    await cache.set("inline", "1", 1000);
    await cache.set("permanent", "2", null);
    await cache.delete("inline");
    await cache.delete("permanent");
    expect(await cache.get("inline")).toBeNull();
    expect(await cache.get("permanent")).toBeNull();
    expect(await allFiles(dir)).toEqual([]);
    await cache.close();
  });
});
