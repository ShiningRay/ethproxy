import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const upstreamSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  weight: z.number().int().positive().default(1),
});

const healthSchema = z.object({
  pollIntervalMs: z.number().int().positive().default(5000),
  requestTimeoutMs: z.number().int().positive().default(10000),
  maxBlockLag: z.number().int().nonnegative().default(5),
  failureThreshold: z.number().int().positive().default(3),
  maxRetries: z.number().int().positive().default(2),
});

const cacheSchema = z.object({
  backend: z.enum(["memory", "redis"]).default("memory"),
  shortTtlMs: z.number().int().positive().default(2000),
  pendingTtlMs: z.number().int().positive().default(1000),
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

const configSchema = z.object({
  listen: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8545),
    })
    .default({ host: "0.0.0.0", port: 8545 }),
  upstreams: z.array(upstreamSchema).min(1),
  /**
   * Expected chain id (e.g. 1 for mainnet). When set, upstreams reporting a
   * different eth_chainId are excluded. When unset, the pool adopts the
   * majority chain id among responsive upstreams.
   */
  chainId: z.number().int().positive().optional(),
  health: healthSchema.default({}),
  cache: cacheSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type HealthConfig = z.infer<typeof healthSchema>;
export type CacheConfig = z.infer<typeof cacheSchema>;

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
