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

const TOKEN_A = "8f3a7b2e5c1d9406ab3f7e2d81c5b60a";
const TOKEN_B = "d91c4f60b7a23e58c0fd1b24ae697d33";

function baseConfig(tweak?: (config: Config) => void): Config {
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    statusPagePath: "/",
    hideUpstreamUrls: false,
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
    auth: {
      enabled: true,
      username: undefined,
      password: undefined,
      tokens: [TOKEN_A, TOKEN_B],
      tokenParam: "token",
      realm: "ethproxy",
      exemptPaths: ["/healthz"],
    },
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

const rpc = (url: string, headers?: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
    headers,
  });

describe("Token auth", () => {
  it("rejects requests without a token with 401 and no Basic challenge", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("rejects a wrong token", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/?token=${"0".repeat(32)}`);
    expect(res.status).toBe(401);
  });

  it("accepts a token in the query string and serves the RPC route", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/?token=${TOKEN_A}`);
    // Upstream is unreachable, so the proxy answers a JSON-RPC error — but at
    // HTTP level the request passed auth and reached the handler.
    expect(res.status).toBe(200);
  });

  it("accepts a token via the Authorization: Bearer header", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/`, { authorization: `Bearer ${TOKEN_A}` });
    expect(res.status).toBe(200);
  });

  it("accepts any of the configured tokens", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/?token=${TOKEN_B}`);
    expect(res.status).toBe(200);
  });

  it("honours a custom tokenParam", async () => {
    const { port } = await makeApp((config) => {
      config.auth.tokenParam = "key";
    });
    const ok = await rpc(`http://127.0.0.1:${port}/?key=${TOKEN_A}`);
    expect(ok.status).toBe(200);
    const miss = await rpc(`http://127.0.0.1:${port}/?token=${TOKEN_A}`);
    expect(miss.status).toBe(401);
  });

  it("ignores an empty token value", async () => {
    const { port } = await makeApp();
    const res = await rpc(`http://127.0.0.1:${port}/?token=`);
    expect(res.status).toBe(401);
  });

  it("accepts WebSocket handshakes carrying the token in the query string", async () => {
    const { port } = await makeApp();
    const client = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN_A}`);
    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    client.close();
  });

  it("rejects WebSocket handshakes without a token", async () => {
    const { port } = await makeApp();
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await expect(
      new Promise<void>((_resolve, reject) => {
        client.on("open", () => reject(new Error("unexpected open")));
        client.on("error", reject);
      }),
    ).rejects.toThrow(/401/);
  });

  it("exempts /healthz from token auth", async () => {
    const { port } = await makeApp();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).not.toBe(401);
  });

  it("fails fast when enabled with neither credentials nor tokens (Config built directly)", async () => {
    await expect(
      makeApp((config) => {
        config.auth = { ...config.auth, tokens: [] };
      }),
    ).rejects.toThrow(/auth\.enabled requires/);
  });

  describe("combined with Basic Auth", () => {
    const withBasic = (config: Config): void => {
      config.auth.username = "user";
      config.auth.password = "pass";
    };

    it("accepts Basic credentials when both methods are configured", async () => {
      const { port } = await makeApp(withBasic);
      const res = await rpc(`http://127.0.0.1:${port}/`, {
        authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
      });
      expect(res.status).toBe(200);
    });

    it("accepts the token when Basic credentials are wrong", async () => {
      const { port } = await makeApp(withBasic);
      const res = await rpc(`http://127.0.0.1:${port}/?token=${TOKEN_A}`, {
        authorization: `Basic ${Buffer.from("user:wrong").toString("base64")}`,
      });
      expect(res.status).toBe(200);
    });

    it("sends the Basic challenge on 401 when Basic is configured", async () => {
      const { port } = await makeApp(withBasic);
      const res = await rpc(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Basic realm="ethproxy", charset="UTF-8"');
    });
  });
});
