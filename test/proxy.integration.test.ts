import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import { buildServer } from "../src/server.js";

interface MockNode {
  url: string;
  hits: Map<string, number>;
  setFail: (fail: boolean) => void;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function startMockNode(
  block: number,
  handlers: Record<string, (params: unknown[]) => unknown> = {},
  delayMs = 0,
): Promise<MockNode> {
  let fail = false;
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (fail) {
        res.writeHead(500).end("boom");
        return;
      }
      // WS probes against the derived wsUrl arrive here as GET upgrade
      // requests with no body — reject cleanly instead of hanging.
      let parsed:
        | { id: number | string; method: string; params?: unknown[] }
        | { id: number | string; method: string; params?: unknown[] }[];
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const respond = () => {
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const replies = list.map((call) => {
          hits.set(call.method, (hits.get(call.method) ?? 0) + 1);
          if (call.method === "eth_syncing") {
            return { jsonrpc: "2.0", id: call.id, result: false };
          }
          if (call.method === "eth_blockNumber" && !handlers.eth_blockNumber) {
            return { jsonrpc: "2.0", id: call.id, result: `0x${block.toString(16)}` };
          }
          const handler = handlers[call.method];
          if (handler) {
            return { jsonrpc: "2.0", id: call.id, result: handler(call.params ?? []) };
          }
          return {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32601, message: "method not found" },
          };
        });
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
      };
      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    setFail: (f) => {
      fail = f;
    },
  };
}

async function makeProxy(nodes: MockNode[], weights: number[] = []) {
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    upstreams: nodes.map((n, i) => ({
      name: `node-${i}`,
      url: n.url,
      weight: weights[i] ?? 1,
    })),
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 2000,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    },
    cache: {
      backend: "memory",
      shortTtlMs: 60000, // long enough for deterministic assertions
      pendingTtlMs: 1000,
      dynamicTtl: false, // static TTL keeps tests deterministic
      minTtlMs: 200,
      finalityDepth: 64,
      memory: { maxEntries: 1000 },
    },
    security: {
      blockedNamespaces: ["admin", "personal", "debug", "trace", "miner", "txpool"],
      maxBatchSize: 5,
      maxBodyBytes: 1048576,
      maxLogsRange: 100,
    },
  };
  const pool = new UpstreamPool(config.upstreams, config.health);
  await pool.pollAll();
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
  );
  return { config, pool, proxy };
}

describe("ProxyHandler", () => {
  it("serves repeated eth_blockNumber from cache", async () => {
    const node = await startMockNode(1000);
    const { proxy } = await makeProxy([node]);

    const req = { jsonrpc: "2.0" as const, id: 1, method: "eth_blockNumber", params: [] };
    const first = await proxy.handle(req);
    const second = await proxy.handle(req);
    expect(first).toMatchObject({ result: "0x3e8" });
    expect(second).toMatchObject({ result: "0x3e8" });
    // pollAll() hits eth_blockNumber once; the first proxy call forwards it,
    // the second is served from cache.
    expect(node.hits.get("eth_blockNumber")).toBe(2);
  });

  it("permanently caches mined transaction receipts", async () => {
    const node = await startMockNode(1000, {
      eth_getTransactionReceipt: () => ({ blockHash: "0xabc", status: "0x1" }),
    });
    const { proxy } = await makeProxy([node]);
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "eth_getTransactionReceipt",
      params: ["0xtx"],
    };
    await proxy.handle(req);
    const again = await proxy.handle(req);
    expect(again).toMatchObject({ result: { blockHash: "0xabc" } });
    expect(node.hits.get("eth_getTransactionReceipt")).toBe(1);
  });

  it("never caches eth_sendRawTransaction", async () => {
    const node = await startMockNode(1000, {
      eth_sendRawTransaction: () => "0xtxhash",
    });
    const { proxy } = await makeProxy([node]);
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "eth_sendRawTransaction",
      params: ["0xsigned"],
    };
    await proxy.handle(req);
    await proxy.handle(req);
    expect(node.hits.get("eth_sendRawTransaction")).toBe(2);
  });

  it("fails over to the next upstream on transport errors", async () => {
    const a = await startMockNode(1000);
    const b = await startMockNode(1000, {
      eth_getBalance: () => "0xde0b6b3a7640000",
    });
    const { proxy } = await makeProxy([a, b]);
    a.setFail(true);

    const res = await proxy.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: ["0xaddr", "latest"],
    });
    expect(res).toMatchObject({ result: "0xde0b6b3a7640000" });
  });

  it("applies exponential backoff between retry attempts", async () => {
    const a = await startMockNode(1000);
    const b = await startMockNode(1000, { eth_getBalance: () => "0x1" });
    const { config, proxy } = await makeProxy([a, b]);
    // ProxyHandler reads config at call time, so this takes effect.
    config.health.retryBaseDelayMs = 50;
    config.health.retryMaxDelayMs = 500;
    a.setFail(true);

    const started = Date.now();
    const res = await proxy.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: ["0xaddr", "latest"],
    });
    const elapsed = Date.now() - started;

    expect(res).toMatchObject({ result: "0x1" });
    // the second attempt must have waited ~retryBaseDelayMs
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("returns -32002 when no upstream is usable", async () => {
    const a = await startMockNode(1000);
    const { pool, proxy } = await makeProxy([a]);
    a.setFail(true);
    await pool.pollAll();
    await pool.pollAll(); // crosses failureThreshold: 2

    const res = await proxy.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "eth_getBalance",
      params: ["0xaddr", "latest"],
    });
    expect(res).toMatchObject({
      id: 7,
      error: { code: -32002 },
    });
  });

  it("forwards batch misses as one upstream batch and merges by id", async () => {
    const node = await startMockNode(1000, {
      eth_getBalance: (params) => `balance:${params[0]}`,
    });
    const { proxy } = await makeProxy([node]);

    const res = await proxy.handle([
      { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xaaa", "latest"] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xbbb", "latest"] },
    ]);
    expect(res).toEqual([
      { jsonrpc: "2.0", id: 1, result: "balance:0xaaa" },
      { jsonrpc: "2.0", id: 2, result: "balance:0xbbb" },
    ]);
    expect(node.hits.get("eth_getBalance")).toBe(2);

    // Second batch: both items are cached now.
    const again = await proxy.handle([
      { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xaaa", "latest"] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xbbb", "latest"] },
    ]);
    expect(again).toEqual([
      { jsonrpc: "2.0", id: 1, result: "balance:0xaaa" },
      { jsonrpc: "2.0", id: 2, result: "balance:0xbbb" },
    ]);
    expect(node.hits.get("eth_getBalance")).toBe(2);
  });

  it("passes through upstream JSON-RPC errors without retrying", async () => {
    const node = await startMockNode(1000); // unknown methods -> -32601
    const { proxy } = await makeProxy([node]);
    const res = await proxy.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "eth_unknownMethod",
      params: [],
    });
    expect(res).toMatchObject({ error: { code: -32601 } });
  });

  it("coalesces concurrent identical requests (single-flight)", async () => {
    const node = await startMockNode(1000, {}, 20); // 20ms latency ensures overlap
    const { proxy } = await makeProxy([node]);
    const baseline = node.hits.get("eth_blockNumber") ?? 0;

    const makeReq = (id: number) => ({
      jsonrpc: "2.0" as const,
      id,
      method: "eth_blockNumber",
      params: [],
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => proxy.handle(makeReq(i + 1))),
    );

    // 10 concurrent misses -> exactly 1 upstream call
    expect(node.hits.get("eth_blockNumber")).toBe(baseline + 1);
    // every follower still gets its own id and the shared result
    responses.forEach((r, i) => {
      expect(r).toMatchObject({ id: i + 1, result: "0x3e8" });
    });
  });

  it("rejects blocked methods without touching upstream", async () => {
    const node = await startMockNode(1000);
    const { proxy } = await makeProxy([node]);

    const res = await proxy.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "debug_traceTransaction",
      params: ["0xtx"],
    });
    expect(res).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(node.hits.get("debug_traceTransaction") ?? 0).toBe(0);
  });

  it("rejects oversized batches", async () => {
    const node = await startMockNode(1000);
    const { proxy } = await makeProxy([node]); // maxBatchSize: 5

    const batch = Array.from({ length: 6 }, (_, i) => ({
      jsonrpc: "2.0" as const,
      id: i,
      method: "eth_blockNumber",
      params: [],
    }));
    const res = await proxy.handle(batch);
    expect(res).toMatchObject({ error: { code: -32600 } });
  });

  it("rejects eth_getLogs ranges beyond the limit", async () => {
    const node = await startMockNode(1000, {
      eth_getLogs: () => [],
    });
    const { proxy } = await makeProxy([node]); // maxLogsRange: 100, chainHead: 1000

    const tooWide = await proxy.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: "latest" }],
    });
    expect(tooWide).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(node.hits.get("eth_getLogs") ?? 0).toBe(0);

    const fine = await proxy.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getLogs",
      params: [{ fromBlock: "0x3e0", toBlock: "0x3e8" }],
    });
    expect(fine).toMatchObject({ id: 2, result: [] });
  });
});

describe("server endpoints", () => {
  it("exposes /healthz and /status", async () => {
    const node = await startMockNode(1000);
    const { config, pool, proxy } = await makeProxy([node]);
    const app = await buildServer(proxy, pool, config);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    const status = await app.inject({ method: "GET", url: "/status" });
    const body = status.json() as {
      chainHead: number;
      upstreams: { name: string; healthy: boolean }[];
    };
    expect(body.chainHead).toBe(1000);
    expect(body.upstreams[0]).toMatchObject({ name: "node-0", healthy: true });

    node.setFail(true);
    await pool.pollAll();
    await pool.pollAll();
    const down = await app.inject({ method: "GET", url: "/healthz" });
    expect(down.statusCode).toBe(503);

    await app.close();
  });

  it("serves an HTML index page on GET /", async () => {
    const node = await startMockNode(1000);
    const { config, pool, proxy } = await makeProxy([node]);
    const app = await buildServer(proxy, pool, config);

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("ethproxy");
    expect(res.body).toContain("memory"); // cache backend

    await app.close();
  });

  it("reports cache statistics on /status", async () => {
    const node = await startMockNode(1000);
    const { config, pool, proxy } = await makeProxy([node]);
    const app = await buildServer(proxy, pool, config);

    const req = { jsonrpc: "2.0" as const, id: 1, method: "eth_blockNumber", params: [] };
    await proxy.handle(req); // miss + store
    await proxy.handle(req); // hit

    const status = await app.inject({ method: "GET", url: "/status" });
    const body = status.json() as {
      cache: { hits: number; misses: number; sets: number; hitRate: number };
    };
    expect(body.cache.hits).toBe(1);
    expect(body.cache.misses).toBe(1);
    expect(body.cache.sets).toBe(1);
    expect(body.cache.hitRate).toBe(0.5);

    await app.close();
  });
});
