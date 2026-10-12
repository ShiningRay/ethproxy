import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import { buildServer } from "../src/server.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function baseConfig(tweak?: (config: Config) => void): Config {
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    statusPagePath: "/",
    upstreams: [{ name: "a", url: "http://127.0.0.1:1", weight: 1 }],
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 500,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      wsHeads: false,
      wsPingIntervalMs: 30000,
    },
    cache: {
      enabled: true,
      backend: "memory",
      shortTtlMs: 60000,
      unfinalizedTtlMs: 900000,
      pendingTtlMs: 1000,
      dynamicTtl: false,
      minTtlMs: 200,
      finalityDepth: 64,
      memory: { maxEntries: 1000 },
    },
    security: {
      blockedNamespaces: ["admin", "personal", "debug", "trace", "miner", "txpool"],
      maxBatchSize: 100,
      maxBodyBytes: 1048576,
      maxLogsRange: 10000,
    },
    rateLimit: {
      enabled: false,
      requestsPerSecond: 50,
      burst: 100,
      batchCost: "items",
      wsMessagesPerSecond: 20,
      wsBurst: 40,
      maxSubscriptionsPerIp: 20,
    },
    filters: { stickyTtlMs: 300000 },
    txpool: { mirror: false },
    syncing: { mirror: false },
    reorg: { enabled: true, windowSize: 128 },
    cors: { enabled: true, origin: "*" },
    upstreamCooldown: { defaultMs: 15000, maxMs: 300000 },
    auth: { enabled: true, username: "user", password: "pass", realm: "ethproxy", exemptPaths: ["/healthz"] },
  };
  tweak?.(config);
  return config;
}

/** Upstream is unreachable on purpose: auth rejects (or passes) before the pool is ever contacted. */
async function makeApp(tweak?: (config: Config) => void) {
  const config = baseConfig(tweak);
  const pool = new UpstreamPool(config.upstreams, { ...config.health, wsHeads: false });
  cleanups.push(() => pool.stop());
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
  );
  const app = await buildServer(proxy, pool, config);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return { port, pool };
}

const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("HTTP Basic Auth", () => {
  it("rejects requests without credentials with 401 and a WWW-Authenticate challenge", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="ethproxy", charset="UTF-8"');
  });

  it("rejects wrong credentials with 401", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "{}",
      headers: { authorization: basic("user", "wrong") },
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct credentials and serves the RPC route", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      headers: { authorization: basic("user", "pass") },
    });
    // Upstream is unreachable, so the proxy answers a JSON-RPC error — but at
    // HTTP level the request passed auth and reached the handler.
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("rejects credentials containing no colon separator", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Basic ${Buffer.from("nocolon").toString("base64")}` },
    });
    expect(res.status).toBe(401);
  });

  it("protects /status and /metrics", async () => {
    const { port } = await makeApp();
    for (const path of ["/status", "/metrics"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(401);
    }
  });

  it("exempts /healthz by default", async () => {
    const { port, pool } = await makeApp();
    // No eligible upstream (mock upstream is unreachable): healthz reports 503,
    // proving the request reached the handler instead of the auth challenge.
    expect(pool.hasEligible()).toBe(false);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(503);
  });

  it("supports additional exempt paths", async () => {
    const { port } = await makeApp((config) => {
      config.auth.exemptPaths = ["/healthz", "/status"];
    });
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
  });

  it("lets CORS preflight through without credentials", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        origin: "https://dapp.example",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects WebSocket upgrades without credentials", async () => {
    const { port } = await makeApp();
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const error = await new Promise<Error>((resolve, reject) => {
      client.on("open", () => reject(new Error("handshake should have failed")));
      client.on("error", resolve);
    });
    expect(error.message).toContain("401");
  });

  it("accepts WebSocket upgrades with credentials", async () => {
    const { port } = await makeApp();
    const client = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { authorization: basic("user", "pass") },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    client.close();
  });

  it("fails fast when enabled without credentials (Config built directly)", async () => {
    await expect(
      makeApp((config) => {
        config.auth = { ...config.auth, username: undefined, password: undefined };
      }),
    ).rejects.toThrow(/auth\.enabled requires/);
  });
});
