import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import {
  loadConfig,
  type Config,
  type UpstreamConfig,
  type UpstreamCooldownConfig,
} from "../src/config.js";
import { StickyFilterRouter } from "../src/filters.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import type { JsonRpcResponse } from "../src/rpc.js";
import {
  isRateLimitMessage,
  parseRetryAfter,
  TokenBucket,
  Upstream,
  UpstreamThrottledError,
} from "../src/upstream.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

interface RecordedRequest {
  methods: string[];
  isBatch: boolean;
}

/** Minimal JSON-RPC mock node with a scripted responder. */
async function startMock(
  respond: (parsed: unknown) => {
    status?: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      // WS probes hit the plain HTTP port as GET upgrade requests.
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // keep null; responder decides
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      requests.push({
        methods: list.map(
          (c) => (c as { method?: string } | null)?.method ?? "",
        ),
        isBatch: Array.isArray(parsed),
      });
      const r = respond(parsed);
      res
        .writeHead(r.status ?? 200, {
          "content-type": "application/json",
          ...r.headers,
        })
        .end(r.body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

/** Health-poll batch detection: the pool's poll sends eth_syncing. */
function isPoll(parsed: unknown): boolean {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.some(
    (c) => (c as { method?: string } | null)?.method === "eth_syncing",
  );
}

/** Standard replies for the health-poll batch (syncing false, block 100, chain 1). */
function pollReply(parsed: unknown): string {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = list.map((c) => {
    const call = c as { id: number; method: string };
    if (call.method === "eth_syncing") {
      return { jsonrpc: "2.0", id: call.id, result: false };
    }
    if (call.method === "eth_blockNumber") {
      return { jsonrpc: "2.0", id: call.id, result: "0x64" };
    }
    if (call.method === "eth_chainId") {
      return { jsonrpc: "2.0", id: call.id, result: "0x1" };
    }
    return { jsonrpc: "2.0", id: call.id, result: null };
  });
  return JSON.stringify(Array.isArray(parsed) ? out : out[0]);
}

function makeConfig(upstreams: UpstreamConfig[]): Config {
  return {
    listen: { host: "127.0.0.1", port: 8545 },
    statusPagePath: "/",
    upstreams,
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 2000,
      maxBlockLag: 5,
      failureThreshold: 3,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      wsHeads: false,
      wsPingIntervalMs: 30000,
    },
    cache: {
      enabled: false,
      backend: "memory",
      shortTtlMs: 2000,
      pendingTtlMs: 1000,
      unfinalizedTtlMs: 900000,
      dynamicTtl: true,
      minTtlMs: 200,
      finalityDepth: 64,
      memory: { maxEntries: 1000 },
    },
    security: {
      blockedNamespaces: ["admin", "debug"],
      maxBatchSize: 100,
      maxBodyBytes: 1048576,
      maxLogsRange: 10000,
    },
    rateLimit: {
      enabled: false,
      requestsPerSecond: 50,
      burst: 100,
      wsMessagesPerSecond: 20,
      wsBurst: 40,
      maxSubscriptionsPerIp: 20,
    },
    filters: { stickyTtlMs: 300000 },
    txpool: { mirror: false },
    syncing: { mirror: false },
    reorg: { enabled: false, windowSize: 128 },
    cors: { enabled: true, origin: "*" },
    upstreamCooldown: { defaultMs: 15000, maxMs: 300000 },
  };
}

async function startStack(
  upstreamConfigs: UpstreamConfig[],
  cooldown?: UpstreamCooldownConfig,
): Promise<{ config: Config; pool: UpstreamPool; proxy: ProxyHandler }> {
  const config = makeConfig(upstreamConfigs);
  if (cooldown) config.upstreamCooldown = cooldown;
  const pool = new UpstreamPool(
    config.upstreams,
    config.health,
    undefined,
    config.chainId,
    config.txpool,
    config.syncing,
    config.reorg,
    config.upstreamCooldown,
  );
  await pool.pollAll();
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
    new StickyFilterRouter(config.filters.stickyTtlMs),
  );
  return { config, pool, proxy };
}

const RPC = (id: number, method: string) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params: [] as unknown[],
});

describe("TokenBucket", () => {
  it("starts full, drains, and refills over time", () => {
    const b = new TokenBucket(10, 2, 0); // 10/s, capacity 2
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.ready(0)).toBe(false);
    expect(b.msUntilReady(0)).toBe(100);
    expect(b.take(100)).toBe(true); // 0.1s -> 1 token
    expect(b.take(100)).toBe(false);
  });

  it("caps the refill at capacity after a long idle", () => {
    const b = new TokenBucket(10, 2, 0);
    b.take(0);
    b.take(0);
    expect(b.ready(60_000)).toBe(true);
    expect(b.take(60_000)).toBe(true);
    expect(b.take(60_000)).toBe(true); // capacity 2, not more
    expect(b.take(60_000)).toBe(false);
  });
});

describe("parseRetryAfter / isRateLimitMessage", () => {
  it("parses delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(at);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("returns null for missing or invalid values", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("matches common rate-limit phrasings", () => {
    expect(isRateLimitMessage("rate limit exceeded")).toBe(true);
    expect(isRateLimitMessage("Too Many Requests")).toBe(true);
    expect(
      isRateLimitMessage(
        "The key exceeds the frequency limit(15), and the query server is suspended for 28 s",
      ),
    ).toBe(true);
    expect(
      isRateLimitMessage("You've reached the usage limit for your current plan"),
    ).toBe(true);
    expect(isRateLimitMessage("quota exceeded")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isRateLimitMessage("method not found")).toBe(false);
    expect(
      isRateLimitMessage("execution reverted: exceeds block gas limit"),
    ).toBe(false);
    expect(isRateLimitMessage(undefined)).toBe(false);
  });
});

describe("Upstream rate-limit cooldown", () => {
  it("parks the upstream on HTTP 429 and uses Retry-After", async () => {
    const mock = await startMock(() => ({
      status: 429,
      headers: { "retry-after": "1" },
      body: "rate limited",
    }));
    const u = new Upstream(
      { name: "m", url: mock.url, weight: 1 },
      2000,
      { defaultMs: 5000, maxMs: 60000 },
    );
    await expect(u.call(RPC(1, "eth_chainId"))).rejects.toBeInstanceOf(
      UpstreamThrottledError,
    );
    const st = u.status();
    expect(st.throttled).toBe(true);
    const remaining = (st.throttledUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(800);
    expect(remaining).toBeLessThanOrEqual(1000);
  });

  it("falls back to the configured default cooldown", async () => {
    const mock = await startMock(() => ({ status: 429, body: "limited" }));
    const u = new Upstream(
      { name: "m", url: mock.url, weight: 1 },
      2000,
      { defaultMs: 8000, maxMs: 60000 },
    );
    await expect(u.call(RPC(1, "eth_chainId"))).rejects.toBeInstanceOf(
      UpstreamThrottledError,
    );
    const remaining = (u.status().throttledUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(7000);
    expect(remaining).toBeLessThanOrEqual(8000);
  });

  it("prefers a per-upstream cooldownMs and caps it at maxMs", async () => {
    const mock = await startMock(() => ({
      status: 429,
      headers: { "retry-after": "99999" },
      body: "limited",
    }));
    const u = new Upstream(
      { name: "m", url: mock.url, weight: 1, cooldownMs: 2000 },
      2000,
      { defaultMs: 5000, maxMs: 60000 },
    );
    await expect(u.call(RPC(1, "eth_chainId"))).rejects.toBeInstanceOf(
      UpstreamThrottledError,
    );
    const remaining = (u.status().throttledUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(1500);
    expect(remaining).toBeLessThanOrEqual(2000);

    // No per-upstream override: Retry-After is capped at maxMs.
    const mock2 = await startMock(() => ({
      status: 429,
      headers: { "retry-after": "99999" },
      body: "limited",
    }));
    const u2 = new Upstream(
      { name: "m2", url: mock2.url, weight: 1 },
      2000,
      { defaultMs: 5000, maxMs: 3000 },
    );
    await expect(u2.call(RPC(1, "eth_chainId"))).rejects.toBeInstanceOf(
      UpstreamThrottledError,
    );
    const remaining2 = (u2.status().throttledUntil ?? 0) - Date.now();
    expect(remaining2).toBeGreaterThan(2000);
    expect(remaining2).toBeLessThanOrEqual(3000);
  });

  it("parks on a rate-limit JSON-RPC error but still returns the response", async () => {
    const mock = await startMock(() => ({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32005, message: "rate limit exceeded" },
      }),
    }));
    const u = new Upstream(
      { name: "m", url: mock.url, weight: 1 },
      2000,
      { defaultMs: 7000, maxMs: 60000 },
    );
    const res = (await u.call(RPC(1, "eth_chainId"))) as JsonRpcResponse;
    expect(res.error?.message).toBe("rate limit exceeded");
    const remaining = (u.status().throttledUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(6000);
    expect(remaining).toBeLessThanOrEqual(7000);
  });

  it("does not park on unrelated JSON-RPC errors", async () => {
    const mock = await startMock(() => ({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found" },
      }),
    }));
    const u = new Upstream({ name: "m", url: mock.url, weight: 1 }, 2000);
    await u.call(RPC(1, "eth_chainId"));
    expect(u.status().throttled).toBe(false);
  });
});

describe("integration: 429 failover and parked-upstream skip", () => {
  it("fails over to the second upstream, parks the first, and skips it afterwards", async () => {
    const a = await startMock((parsed) =>
      isPoll(parsed)
        ? { body: pollReply(parsed) }
        : { status: 429, headers: { "retry-after": "60" }, body: "limited" },
    );
    const b = await startMock((parsed) =>
      isPoll(parsed)
        ? { body: pollReply(parsed) }
        : {
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: (parsed as { id: number }).id,
              result: "0xbeef",
            }),
          },
    );
    const { pool, proxy } = await startStack([
      { name: "a", url: a.url, weight: 2 },
      { name: "b", url: b.url, weight: 1 },
    ]);
    const forward = (m: RecordedRequest[]) =>
      m.filter((r) => !r.methods.includes("eth_syncing")).length;

    // First request: weighted order picks A first; A answers 429, the
    // request fails over to B, and A gets parked.
    const r1 = (await proxy.handle(RPC(1, "eth_gasPrice"))) as JsonRpcResponse;
    expect(r1.result).toBe("0xbeef");
    expect(pool.byName("a")!.isThrottled()).toBe(true);
    expect(forward(a.requests)).toBe(1);
    expect(forward(b.requests)).toBe(1);

    // Second request: A is parked — everything goes to B.
    const r2 = (await proxy.handle(RPC(2, "eth_gasPrice"))) as JsonRpcResponse;
    expect(r2.result).toBe("0xbeef");
    expect(forward(a.requests)).toBe(1);
    expect(forward(b.requests)).toBe(2);
  });
});

describe("integration: upstream pacing (config.rateLimit)", () => {
  it("waits for a token before hitting a paced upstream again", async () => {
    const c = await startMock((parsed) =>
      isPoll(parsed)
        ? { body: pollReply(parsed) }
        : {
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: (parsed as { id: number }).id,
              result: "0x1",
            }),
          },
    );
    const { proxy } = await startStack([
      {
        name: "c",
        url: c.url,
        weight: 1,
        rateLimit: { requestsPerSecond: 10, burst: 1 },
      },
    ]);
    // Let the bucket refill after the polling burst (capacity 1 = 100ms).
    await new Promise((r) => setTimeout(r, 250));
    await proxy.handle(RPC(1, "eth_gasPrice"));
    const t1 = Date.now();
    await proxy.handle(RPC(2, "eth_gasPrice"));
    const dt = Date.now() - t1;
    expect(dt).toBeGreaterThanOrEqual(60); // ~100ms refill for the second token
    expect(dt).toBeLessThan(1500);
    expect(
      c.requests.filter((r) => !r.methods.includes("eth_syncing")).length,
    ).toBe(2);
  });
});

describe("config: upstream rate limits and cooldown", () => {
  function writeConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ethproxy-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, body);
    return path;
  }

  it("parses per-upstream rateLimit and cooldownMs", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    rateLimit:
      requestsPerSecond: 5
      burst: 10
    cooldownMs: 2000
`);
    const config = loadConfig(path);
    expect(config.upstreams[0]!.rateLimit).toEqual({
      requestsPerSecond: 5,
      burst: 10,
    });
    expect(config.upstreams[0]!.cooldownMs).toBe(2000);
    // Global defaults when the section is absent.
    expect(config.upstreamCooldown).toEqual({
      defaultMs: 15000,
      maxMs: 300000,
    });
  });

  it("honours a custom upstreamCooldown section", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
upstreamCooldown:
  defaultMs: 3000
  maxMs: 60000
`);
    const config = loadConfig(path);
    expect(config.upstreamCooldown).toEqual({ defaultMs: 3000, maxMs: 60000 });
  });

  it("rejects a non-positive requestsPerSecond", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    rateLimit:
      requestsPerSecond: 0
`);
    expect(() => loadConfig(path)).toThrow();
  });
});
