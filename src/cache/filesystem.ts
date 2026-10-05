import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CacheBackend } from "./types.js";

/**
 * On-disk envelope: expiry is the source of truth (file mtime is never relied
 * on for correctness). `e === null` means the entry never expires.
 */
interface FileEnvelope {
  e: number | null;
  v: string;
}

const SHARDS = 256;

/**
 * Storage tiers:
 *
 * - inline (memory): entries with a short TTL are kept in a bounded LRU and
 *   never touch the disk. Public RPC traffic makes high-cardinality
 *   short-TTL keys (each distinct eth_call calldata is its own key) and
 *   writing them one-file-per-entry churns kernel dentry/inode caches,
 *   which shows up in cgroup memory accounting as a slow "leak".
 * - `t/<bucketId>/<sha256>`: expiring entries too long-lived for the inline
 *   tier, grouped into time buckets (`bucketId = floor(expiry/bucketMs)`).
 *   The sweep deletes whole expired buckets — no per-file stat or content
 *   read is needed to decide expiry.
 * - `p/<2-hex shard>/<sha256>`: never-expiring entries, kept per-shard as
 *   before. Subject only to the maxBytes budget (oldest-written first).
 *
 * Directories from the pre-bucketing layout (`<2-hex shard>` directly under
 * the root) are migrated once at startup into `p/` (or dropped when already
 * expired), so existing caches survive the upgrade.
 */
export class FilesystemCacheBackend implements CacheBackend {
  private readonly root: string;
  private readonly sweepIntervalMs: number;
  private readonly maxBytes: number;
  private readonly bucketMs: number;
  private readonly inlineTtlMs: number;
  private readonly logger?: FilesystemCacheOptions["logger"];

  /** Short-TTL tier; null when disabled (inlineTtlMs: 0). */
  private readonly inlineCache: LRUCache<string, string> | null;
  /** sha256(key) -> bucketId for entries stored under t/. */
  private readonly bucketIndex = new Map<string, number>();
  /** Legacy-layout migration + t/ index rebuild; awaited by every op. */
  private ready: Promise<void>;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(dir: string, opts: FilesystemCacheOptions = {}) {
    this.root = dir;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60000;
    this.maxBytes = opts.maxBytes ?? 1073741824;
    this.bucketMs = opts.bucketMs ?? 3600000;
    this.inlineTtlMs = opts.inlineTtlMs ?? 60000;
    this.logger = opts.logger;
    this.inlineCache =
      this.inlineTtlMs > 0
        ? new LRUCache<string, string>({
            max: opts.inlineMaxEntries ?? 10000,
          })
        : null;
    if (this.sweepIntervalMs > 0) {
      // Unref so the sweep never keeps the process alive on shutdown.
      this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
    this.ready = this.bootstrap();
  }

  /** Content-addressed path for a never-expiring key: <root>/p/<2-hex>/<sha256>. */
  pathForKey(key: string): string {
    const digest = this.digest(key);
    return join(this.root, "p", digest.slice(0, 2), digest);
  }

  private bucketPath(bucket: number, digest: string): string {
    return join(this.root, "t", String(bucket), digest);
  }

  private digest(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  /** Migrate the legacy layout and rebuild the t/ bucket index. */
  private async bootstrap(): Promise<void> {
    try {
      await mkdir(join(this.root, "p"), { recursive: true });
      await mkdir(join(this.root, "t"), { recursive: true });
      const entries = await readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "p" || entry.name === "t") continue;
        if (!/^[0-9a-f]{2}$/.test(entry.name)) continue;
        await this.migrateLegacyShard(join(this.root, entry.name));
      }
      await this.rebuildBucketIndex();
    } catch (err) {
      // Best-effort: the cache still works for new entries; old ones are
      // simply not found. Never block serving on migration problems.
      this.logger?.warn("cache bootstrap failed; legacy entries may be lost", err);
    }
  }

  /** Move one legacy shard directory's files into the new layout. */
  private async migrateLegacyShard(shardDir: string): Promise<void> {
    for (const name of await readdir(shardDir)) {
      const path = join(shardDir, name);
      // Legacy file names are sha256(key); leftover temp files from a crash
      // mid-write are garbage.
      const digest = /^[0-9a-f]{64}$/.test(name) ? name : null;
      if (digest === null) {
        await this.unlinkQuiet(path);
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        await this.unlinkQuiet(path);
        continue;
      }
      let env: FileEnvelope;
      try {
        env = JSON.parse(raw) as FileEnvelope;
      } catch {
        await this.unlinkQuiet(path);
        continue;
      }
      if (env.e !== null && env.e <= Date.now()) {
        await this.unlinkQuiet(path);
        continue;
      }
      if (env.e === null) {
        await mkdir(join(this.root, "p", digest.slice(0, 2)), { recursive: true });
        await rename(path, this.pathForKeyDigest(digest));
      } else {
        const bucket = Math.floor(env.e / this.bucketMs);
        const target = this.bucketPath(bucket, digest);
        await mkdir(join(this.root, "t", String(bucket)), { recursive: true });
        await rename(path, target);
        this.bucketIndex.set(digest, bucket);
      }
    }
    await rm(shardDir, { recursive: true, force: true });
  }

  private pathForKeyDigest(digest: string): string {
    return join(this.root, "p", digest.slice(0, 2), digest);
  }

  /** Rebuild bucketIndex from whatever t/ buckets exist on disk. */
  private async rebuildBucketIndex(): Promise<void> {
    this.bucketIndex.clear();
    let buckets: string[];
    try {
      buckets = await readdir(join(this.root, "t"));
    } catch {
      return;
    }
    for (const bucket of buckets) {
      const bucketId = Number(bucket);
      if (!Number.isInteger(bucketId)) continue;
      let names: string[];
      try {
        names = await readdir(join(this.root, "t", bucket));
      } catch {
        continue;
      }
      for (const name of names) this.bucketIndex.set(name, bucketId);
    }
  }

  private async readEnvelope(path: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let env: FileEnvelope;
    try {
      env = JSON.parse(raw) as FileEnvelope;
    } catch {
      // Corrupt entry (e.g. torn write from a crash before rename): miss.
      await this.unlinkQuiet(path);
      return null;
    }
    if (env.e !== null && env.e <= Date.now()) {
      await this.unlinkQuiet(path);
      return null;
    }
    return env.v;
  }

  async get(key: string): Promise<string | null> {
    await this.ready;
    const inline = this.inlineCache?.get(key);
    if (inline !== undefined) return inline;

    const digest = this.digest(key);
    const bucket = this.bucketIndex.get(digest);
    if (bucket !== undefined) {
      const value = await this.readEnvelope(this.bucketPath(bucket, digest));
      if (value !== null) return value;
      // Expired or vanished: drop the stale index entry, fall through to p/.
      this.bucketIndex.delete(digest);
    }
    return this.readEnvelope(this.pathForKeyDigest(digest));
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    await this.ready;
    const digest = this.digest(key);

    if (this.inlineCache !== null && ttlMs !== null && ttlMs <= this.inlineTtlMs) {
      this.inlineCache.set(key, value, { ttl: ttlMs });
      // A previous longer-lived entry for the same key must not resurface
      // once the inline copy is evicted.
      await this.removeOnDisk(digest);
      return;
    }

    let target: string;
    let indexedBucket: number | null = null;
    if (ttlMs === null) {
      target = this.pathForKeyDigest(digest);
      await mkdir(join(this.root, "p", digest.slice(0, 2)), { recursive: true });
    } else {
      const bucket = Math.floor((Date.now() + ttlMs) / this.bucketMs);
      target = this.bucketPath(bucket, digest);
      await mkdir(join(this.root, "t", String(bucket)), { recursive: true });
      indexedBucket = bucket;
    }
    // A previous inline copy must not shadow this write (get probes the
    // inline tier first) — e.g. a tx hash cached as pending (short TTL) and
    // rewritten once mined (no expiry).
    this.inlineCache?.delete(key);
    // Drop the other tier's stale copy: whichever position the next read
    // probes, it must see this write.
    if (indexedBucket === null) {
      const oldBucket = this.bucketIndex.get(digest);
      if (oldBucket !== undefined) {
        await this.unlinkQuiet(this.bucketPath(oldBucket, digest));
      }
    } else {
      await this.unlinkQuiet(this.pathForKeyDigest(digest));
    }

    const env: FileEnvelope = {
      e: ttlMs === null ? null : Date.now() + ttlMs,
      v: value,
    };
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(temp, JSON.stringify(env), "utf8");
    await rename(temp, target);

    if (indexedBucket !== null) {
      const oldBucket = this.bucketIndex.get(digest);
      if (oldBucket !== undefined && oldBucket !== indexedBucket) {
        await this.unlinkQuiet(this.bucketPath(oldBucket, digest));
      }
      this.bucketIndex.set(digest, indexedBucket);
    } else {
      this.bucketIndex.delete(digest);
    }
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    this.inlineCache?.delete(key);
    await this.removeOnDisk(this.digest(key));
  }

  /** Remove both on-disk copies (bucketed and permanent) of a digest. */
  private async removeOnDisk(digest: string): Promise<void> {
    const bucket = this.bucketIndex.get(digest);
    if (bucket !== undefined) {
      this.bucketIndex.delete(digest);
      await this.unlinkQuiet(this.bucketPath(bucket, digest));
    }
    await this.unlinkQuiet(this.pathForKeyDigest(digest));
  }

  /**
   * One maintenance pass: delete whole expired t/ buckets (no per-file
   * checks needed — every entry in a bucket expires before the bucket does),
   * then enforce the maxBytes budget across t/ and p/, oldest buckets and
   * oldest-written p/ files first. Also usable manually. Errors are logged
   * and swallowed — a failed sweep only means garbage lingers.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.runSweep().catch((err) => {
      this.logger?.warn("cache sweep failed", err);
    });
    try {
      await this.sweeping;
    } finally {
      this.sweeping = null;
    }
  }

  private async runSweep(): Promise<void> {
    const now = Date.now();
    const currentBucket = Math.floor(now / this.bucketMs);

    // Whole expired buckets go, index entries with them.
    let bucketIds: string[];
    try {
      bucketIds = await readdir(join(this.root, "t"));
    } catch {
      bucketIds = [];
    }
    const liveBuckets: number[] = [];
    for (const name of bucketIds) {
      const bucketId = Number(name);
      if (!Number.isInteger(bucketId)) continue;
      if (bucketId < currentBucket) {
        await rm(join(this.root, "t", name), { recursive: true, force: true });
        continue;
      }
      liveBuckets.push(bucketId);
    }
    for (const [digest, bucket] of this.bucketIndex) {
      if (bucket < currentBucket) this.bucketIndex.delete(digest);
    }

    // Budget check across live t/ buckets and the permanent tier. lstat only:
    // file sets are stable between sweeps, so repeated lookups hit the
    // kernel's dentry cache instead of churning it.
    const tFiles: { digest: string; bucket: number; size: number }[] = [];
    const pFiles: { path: string; size: number; mtimeMs: number }[] = [];
    let totalBytes = 0;
    for (const bucketId of liveBuckets) {
      const dir = join(this.root, "t", String(bucketId));
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        let size = 0;
        try {
          size = (await stat(path)).size;
        } catch {
          continue; // vanished mid-sweep
        }
        totalBytes += size;
        tFiles.push({ digest: name, bucket: bucketId, size });
      }
    }
    let pDir: string[];
    try {
      pDir = await readdir(join(this.root, "p"));
    } catch {
      pDir = [];
    }
    for (const shard of pDir) {
      const dir = join(this.root, "p", shard);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // shard never created
      }
      for (const name of names) {
        const path = join(dir, name);
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await stat(path);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue; // vanished mid-sweep
        }
        totalBytes += size;
        pFiles.push({ path, size, mtimeMs });
      }
    }

    if (totalBytes <= this.maxBytes) return;

    // Oldest bucket first: its entries were written first, too.
    for (const bucketId of liveBuckets.sort((a, b) => a - b)) {
      if (totalBytes <= this.maxBytes) break;
      const bucketFiles = tFiles.filter((f) => f.bucket === bucketId);
      if (bucketFiles.length === 0) continue;
      for (const f of bucketFiles) {
        totalBytes -= f.size;
        this.bucketIndex.delete(f.digest);
      }
      await rm(join(this.root, "t", String(bucketId)), {
        recursive: true,
        force: true,
      });
    }
    pFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of pFiles) {
      if (totalBytes <= this.maxBytes) break;
      totalBytes -= file.size;
      await this.unlinkQuiet(file.path);
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.sweeping) await this.sweeping;
    await this.ready;
    this.inlineCache?.clear();
    this.bucketIndex.clear();
  }

  private async unlinkQuiet(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("cache file delete failed", err);
      }
    }
  }
}

/** Options for FilesystemCacheBackend; all optional. */
export interface FilesystemCacheOptions {
  /** Sweep period in ms; 0 disables the background sweep entirely. */
  sweepIntervalMs?: number;
  /**
   * Soft disk budget. When a sweep finds the live total above it, oldest
   * buckets (then oldest-written permanent files) are deleted first until
   * back under budget.
   */
  maxBytes?: number;
  /** Expiring entries are grouped into time buckets of this many ms. */
  bucketMs?: number;
  /** Entries with a TTL at or below this stay in memory; 0 disables. */
  inlineTtlMs?: number;
  /** Max entries held by the in-memory tier. */
  inlineMaxEntries?: number;
  logger?: {
    warn: (msg: string, err?: unknown) => void;
  };
}
