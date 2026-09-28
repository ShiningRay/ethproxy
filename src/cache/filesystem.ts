import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

/** Options for FilesystemCacheBackend; all optional. */
export interface FilesystemCacheOptions {
  /** Sweep period in ms; 0 disables the background sweep entirely. */
  sweepIntervalMs?: number;
  /**
   * Soft disk budget. When a sweep finds the live total above it,
   * oldest-written files are deleted first until back under budget.
   */
  maxBytes?: number;
  logger?: {
    warn: (msg: string, err?: unknown) => void;
  };
}

/**
 * Cache backend that stores entries as files under a directory (two-hex shard
 * subdirectories keep per-directory file counts small). Holds nothing in
 * memory, for deployments where the memory backend's footprint is the problem.
 *
 * Keys are mapped to `sha256(key)` filenames, so any key string (including the
 * plain-text reorg-validated keys containing JSON) is safe on disk. Writes go
 * to a temp file that is renamed into place, so readers never see partial
 * values. Expiry is checked from the stored envelope on every read; expired
 * files are unlinked lazily on read and by the periodic sweep, which also
 * enforces the maxBytes budget.
 */
export class FilesystemCacheBackend implements CacheBackend {
  private readonly root: string;
  private readonly sweepIntervalMs: number;
  private readonly maxBytes: number;
  private readonly logger?: FilesystemCacheOptions["logger"];
  private readonly ensuredShards = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(dir: string, opts: FilesystemCacheOptions = {}) {
    this.root = dir;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60000;
    this.maxBytes = opts.maxBytes ?? 1073741824;
    this.logger = opts.logger;
    if (this.sweepIntervalMs > 0) {
      // Unref so the sweep never keeps the process alive on shutdown.
      this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  /** Content-addressed path for a key: <root>/<2-hex shard>/<sha256>. */
  pathForKey(key: string): string {
    const digest = this.digest(key);
    return join(this.root, digest.slice(0, 2), digest);
  }

  async get(key: string): Promise<string | null> {
    const target = this.pathForKey(key);
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let env: FileEnvelope;
    try {
      env = JSON.parse(raw) as FileEnvelope;
    } catch {
      // Corrupt entry (e.g. torn write from a crash before rename): miss.
      await this.unlinkQuiet(target);
      return null;
    }
    if (env.e !== null && env.e <= Date.now()) {
      await this.unlinkQuiet(target);
      return null;
    }
    return env.v;
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    const shard = join(this.root, this.shardName(key));
    if (!this.ensuredShards.has(shard)) {
      await mkdir(shard, { recursive: true });
      this.ensuredShards.add(shard);
    }
    const env: FileEnvelope = {
      e: ttlMs === null ? null : Date.now() + ttlMs,
      v: value,
    };
    const target = this.pathForKey(key);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(temp, JSON.stringify(env), "utf8");
    await rename(temp, target);
  }

  async delete(key: string): Promise<void> {
    await this.unlinkQuiet(this.pathForKey(key));
  }

  /**
   * One maintenance pass: remove expired (and unreadable) files, then enforce
   * the maxBytes budget oldest-written-first. Also usable manually. Errors are
   * logged and swallowed — a failed sweep only means garbage lingers.
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
    const live: { path: string; size: number; mtimeMs: number }[] = [];
    let totalBytes = 0;
    for (let i = 0; i < SHARDS; i++) {
      const shard = join(this.root, i.toString(16).padStart(2, "0"));
      let names: string[];
      try {
        names = await readdir(shard);
      } catch {
        continue; // shard never created
      }
      for (const name of names) {
        const path = join(shard, name);
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await stat(path);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue; // vanished mid-sweep
        }
        let expired: boolean;
        try {
          const env = JSON.parse(await readFile(path, "utf8")) as FileEnvelope;
          expired = env.e !== null && env.e <= now;
        } catch {
          expired = true; // unreadable/corrupt: garbage
        }
        if (expired) {
          await this.unlinkQuiet(path);
        } else {
          totalBytes += size;
          live.push({ path, size, mtimeMs });
        }
      }
    }
    live.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of live) {
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
  }

  private shardName(key: string): string {
    return this.digest(key).slice(0, 2);
  }

  private digest(key: string): string {
    return createHash("sha256").update(key).digest("hex");
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
