import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const upstreamRateLimitSchema = z.object({
  /** Max requests per second this proxy sends to the upstream. */
  requestsPerSecond: z.number().positive(),
  /** Burst capacity (token-bucket size); defaults to ceil(requestsPerSecond). */
  burst: z.number().int().positive().optional(),
});

const upstreamSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** WebSocket endpoint; defaults to `url` with http(s) swapped to ws(s). */
  wsUrl: z.string().url().optional(),
  weight: z.number().int().positive().default(1),
  /**
   * Client-side pacing: cap the request rate sent to this upstream with a
   * token bucket. Requests prefer upstreams whose bucket has a token ready
   * and wait only when none is; health polls skip the round instead.
   * One token per HTTP request (a batch counts once).
   */
  rateLimit: upstreamRateLimitSchema.optional(),
  /**
   * Overrides upstreamCooldown.defaultMs for this upstream: how long the
   * upstream is parked after answering with a rate-limit error (HTTP 429 or
   * a rate-limit JSON-RPC error).
   */
  cooldownMs: z.number().int().positive().optional(),
});

const healthSchema = z.object({
  pollIntervalMs: z.number().int().positive().default(5000),
  requestTimeoutMs: z.number().int().positive().default(10000),
  maxBlockLag: z.number().int().nonnegative().default(5),
  failureThreshold: z.number().int().positive().default(3),
  maxRetries: z.number().int().positive().default(2),
  /** First retry delay; doubles per attempt, capped at retryMaxDelayMs. */
  retryBaseDelayMs: z.number().int().nonnegative().default(100),
  retryMaxDelayMs: z.number().int().nonnegative().default(1000),
  /**
   * Track chain heads via a persistent eth_subscribe("newHeads") WS
   * connection per upstream (falls back to HTTP polling while WS is down).
   * When false, heads come from the HTTP poll only and WS availability is
   * detected by a per-poll probe instead.
   */
  wsHeads: z.boolean().default(true),
  /**
   * Client-side WS keepalive interval for the persistent per-upstream
   * connection: ping every this many ms, terminate + reconnect when no pong
   * arrives for two intervals. Protects against provider gateways that
   * idle-drop silent connections (close code 1006). 0 disables.
   */
  wsPingIntervalMs: z.number().int().nonnegative().default(30000),
});

const cacheSchema = z.object({
  /** Master switch: when false, requests bypass the cache entirely. */
  enabled: z.boolean().default(true),
  backend: z.enum(["memory", "redis", "filesystem"]).default("memory"),
  shortTtlMs: z.number().int().positive().default(2000),
  pendingTtlMs: z.number().int().positive().default(1000),
  /**
   * Fallback TTL for number-keyed entries below finalityDepth (the seven
   * reorg-validated methods). Correctness comes from read-time validation
   * against the reorg detector's header window; this TTL only bounds the
   * lifetime of entries the window can no longer vouch for (e.g. written
   * across a WS-reconnect gap).
   */
  unfinalizedTtlMs: z.number().int().positive().default(900000),
  /**
   * When enabled, the short TTL is derived from the observed block interval
   * (blockInterval / 4, clamped to [minTtlMs, shortTtlMs]). shortTtlMs then
   * acts as the ceiling and as the fallback before an estimate exists.
   */
  dynamicTtl: z.boolean().default(true),
  minTtlMs: z.number().int().positive().default(200),
  finalityDepth: z.number().int().nonnegative().default(64),
  memory: z
    .object({
      maxEntries: z.number().int().positive().default(100000),
    })
    .default({ maxEntries: 100000 }),
  redis: z
    .object({
      url: z.string().default("redis://127.0.0.1:6379"),
      keyPrefix: z.string().default("ethproxy:"),
    })
    .optional(),
  filesystem: z
    .object({
      /** Directory for cache files; created on demand. */
      dir: z.string().default("./cache"),
      /**
       * Background sweep period: removes expired/corrupt files and enforces
       * maxBytes. 0 disables the sweep (expired entries are still dropped
       * lazily on read, but disk usage is then never reclaimed proactively).
       */
      sweepIntervalMs: z.number().int().nonnegative().default(60000),
      /** Soft disk budget; oldest-written files are evicted first. */
      maxBytes: z.number().int().positive().default(1073741824),
      /**
       * Entries with a TTL at or below this are kept in a bounded in-memory
       * LRU instead of on disk. High-cardinality short-TTL entries (per-call
       * eth_call keys) written one-file-per-entry make the kernel's
       * dentry/inode cache balloon, which reads as a slow "memory leak" in
       * cgroup accounting. 0 disables the in-memory tier. Should stay well
       * below unfinalizedTtlMs so head-tracking entries remain on disk.
       */
      inlineTtlMs: z.number().int().nonnegative().default(60000),
      /** Max entries held by the in-memory tier. */
      inlineMaxEntries: z.number().int().positive().default(10000),
      /**
       * On-disk expiring entries are grouped into time buckets of this many
       * ms (bucket = floor(expiry/bucketMs)); the sweep deletes whole
       * expired buckets instead of stat-ing/reading every file. Current
       * buckets age out one sweep late at worst; reads validate expiry from
       * the stored envelope regardless.
       */
      bucketMs: z.number().int().positive().default(3600000),
    })
    .optional(),
});

const securitySchema = z.object({
  /** JSON-RPC namespaces that are rejected outright (public-RPC hardening). */
  blockedNamespaces: z
    .array(z.string())
    .default(["admin", "personal", "debug", "trace", "miner", "txpool"]),
  /** Max number of elements in a JSON-RPC batch request. */
  maxBatchSize: z.number().int().positive().default(100),
  /** Max HTTP request body size in bytes. */
  maxBodyBytes: z.number().int().positive().default(1048576),
  /** Max fromBlock..toBlock span allowed for eth_getLogs. */
  maxLogsRange: z.number().int().positive().default(10000),
});

const rateLimitSchema = z.object({
  /** Per-client-IP token bucket for HTTP JSON-RPC (and per-IP for WS messages). */
  enabled: z.boolean().default(true),
  requestsPerSecond: z.number().positive().default(50),
  burst: z.number().int().positive().default(100),
  /** WS messages per second per client IP (each JSON-RPC call costs 1). */
  wsMessagesPerSecond: z.number().positive().default(20),
  wsBurst: z.number().int().positive().default(40),
  /** Max concurrent eth_subscribe subscriptions per client IP (across connections). */
  maxSubscriptionsPerIp: z.number().int().positive().default(20),
});

const txpoolSchema = z.object({
  /**
   * Maintain a local pending-transaction mirror via upstream WS
   * newPendingTransactions subscriptions, and answer client
   * eth_subscribe("newPendingTransactions") locally from it.
   * Requires the per-upstream persistent WS connection (shared with
   * health.wsHeads). Default off: the mirror adds one upstream
   * subscription per upstream and a high-traffic event stream.
   */
  mirror: z.boolean().default(false),
});

const syncingSchema = z.object({
  /**
   * Answer client eth_subscribe("syncing") locally from the pool's
   * aggregated view: syncing (with a progress object) while ANY upstream
   * is syncing, false once none are. Status comes from the per-upstream
   * persistent WS syncing feed (shared with health.wsHeads) with the HTTP
   * health poll as fallback. Default off.
   */
  mirror: z.boolean().default(false),
});

const reorgSchema = z.object({
  /**
   * Detect chain reorganizations from upstream newHeads announcements by
   * checking parentHash continuity against a sliding window of recent
   * headers. Confirmed reorgs are logged, counted in metrics and fanned out
   * via pool.onReorg. Requires health.wsHeads (heads carrying hash and
   * parentHash); with plain HTTP polling no hashes are seen.
   */
  enabled: z.boolean().default(true),
  /** Sliding window of recent headers kept for fork-point lookup. */
  windowSize: z.number().int().min(16).default(128),
});

const filtersSchema = z.object({
  /**
   * Idle TTL for proxy-side filter id mappings (sticky routing). Aligned
   * with the node-side filter timeout (geth deletes filters not polled
   * for ~5 minutes); each poll refreshes the deadline.
   */
  stickyTtlMs: z.number().int().positive().default(300000),
});

const corsSchema = z.object({
  enabled: z.boolean().default(true),
  /** "*" allows any origin; otherwise a comma-separated list of origins. */
  origin: z.string().default("*"),
});

const upstreamCooldownSchema = z.object({
  /**
   * Cooldown applied after a rate-limit response when the upstream sent no
   * Retry-After header and no per-upstream cooldownMs is configured (ms).
   */
  defaultMs: z.number().int().nonnegative().default(15000),
  /** Upper bound applied to every cooldown, including Retry-After-derived ones (ms). */
  maxMs: z.number().int().positive().default(300000),
});

const configSchema = z.object({
  listen: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8545),
    })
    .default({ host: "0.0.0.0", port: 8545 }),
  upstreams: z.array(upstreamSchema).min(1),
  /**
   * Path that serves the HTML status page. Defaults to "/" (shared with the
   * WebSocket endpoint). Set a custom path to move the page off the root,
   * or `false` to disable the page entirely (the JSON /status endpoint is
   * unaffected either way).
   */
  statusPagePath: z
    .union([
      z.literal(false),
      z.string().regex(/^\/[a-zA-Z0-9/_-]*$/, "must be an absolute URL path"),
    ])
    .default("/"),
  /**
   * Expected chain id (e.g. 1 for mainnet). When set, upstreams reporting a
   * different eth_chainId are excluded. When unset, the pool adopts the
   * majority chain id among responsive upstreams.
   */
  chainId: z.number().int().positive().optional(),
  // zod 4: .default() demands the full output type; .prefault({}) feeds an
  // empty input through the schema so the per-field defaults apply.
  health: healthSchema.prefault({}),
  cache: cacheSchema.prefault({}),
  security: securitySchema.prefault({}),
  rateLimit: rateLimitSchema.prefault({}),
  filters: filtersSchema.prefault({}),
  txpool: txpoolSchema.prefault({}),
  syncing: syncingSchema.prefault({}),
  reorg: reorgSchema.prefault({}),
  cors: corsSchema.prefault({}),
  upstreamCooldown: upstreamCooldownSchema.prefault({}),
}).superRefine((cfg, ctx) => {
  // Read-time reorg validation is only sound when every unfinalized cached
  // height is covered by the detector's header window.
  if (cfg.reorg.enabled && cfg.reorg.windowSize < cfg.cache.finalityDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reorg", "windowSize"],
      message: `must be >= cache.finalityDepth (${cfg.cache.finalityDepth}) when reorg detection is enabled`,
    });
  }
});

export type Config = z.infer<typeof configSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type UpstreamRateLimitConfig = z.infer<typeof upstreamRateLimitSchema>;
export type UpstreamCooldownConfig = z.infer<typeof upstreamCooldownSchema>;
export type HealthConfig = z.infer<typeof healthSchema>;
export type CacheConfig = z.infer<typeof cacheSchema>;
export type SecurityConfig = z.infer<typeof securitySchema>;
export type RateLimitConfig = z.infer<typeof rateLimitSchema>;
export type FiltersConfig = z.infer<typeof filtersSchema>;
export type TxpoolConfig = z.infer<typeof txpoolSchema>;
export type SyncingConfig = z.infer<typeof syncingSchema>;
export type ReorgConfig = z.infer<typeof reorgSchema>;
export type CorsConfig = z.infer<typeof corsSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw);
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config file ${path}:\n${issues}`);
  }
  return result.data;
}
