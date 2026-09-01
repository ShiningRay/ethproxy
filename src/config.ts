import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const upstreamSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** WebSocket endpoint; defaults to `url` with http(s) swapped to ws(s). */
  wsUrl: z.string().url().optional(),
  weight: z.number().int().positive().default(1),
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
});

const cacheSchema = z.object({
  /** Master switch: when false, requests bypass the cache entirely. */
  enabled: z.boolean().default(true),
  backend: z.enum(["memory", "redis"]).default("memory"),
  shortTtlMs: z.number().int().positive().default(2000),
  pendingTtlMs: z.number().int().positive().default(1000),
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
  health: healthSchema.default({}),
  cache: cacheSchema.default({}),
  security: securitySchema.default({}),
  rateLimit: rateLimitSchema.default({}),
  filters: filtersSchema.default({}),
  txpool: txpoolSchema.default({}),
  syncing: syncingSchema.default({}),
  cors: corsSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type HealthConfig = z.infer<typeof healthSchema>;
export type CacheConfig = z.infer<typeof cacheSchema>;
export type SecurityConfig = z.infer<typeof securitySchema>;
export type RateLimitConfig = z.infer<typeof rateLimitSchema>;
export type FiltersConfig = z.infer<typeof filtersSchema>;
export type TxpoolConfig = z.infer<typeof txpoolSchema>;
export type SyncingConfig = z.infer<typeof syncingSchema>;
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
