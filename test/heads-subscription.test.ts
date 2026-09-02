import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config, HealthConfig } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const health: HealthConfig = {
  pollIntervalMs: 60000,
  requestTimeoutMs: 2000,
  maxBlockLag: 100,
  failureThreshold: 2,
  maxRetries: 2,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
  wsHeads: true,
  wsPingIntervalMs: 30000,
};

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** HTTP endpoint answering the pool's health-poll batch. */
async function startHttpMock(
  initialBlock: number,
  handlers: Record<string, (params: unknown[]) => unknown> = {},
) {
  let block = initialBlock;
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // WS upgrade attempts (no 'upgrade' listener on this server) arrive as
      // GETs with an empty body — reject them cleanly instead of throwing.
      let parsed: { id: number; method: string; params?: unknown[] }[];
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies = list.map((call) => {
        hits.set(call.method, (hits.get(call.method) ?? 0) + 1);
        if (call.method === "eth_syncing") {
          return { jsonrpc: "2.0", id: call.id, result: false };
        }
        if (call.method === "eth_blockNumber") {
          return { jsonrpc: "2.0", id: call.id, result: `0x${block.toString(16)}` };
        }
        if (call.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: call.id, result: "0x1" };
        }
        const handler = handlers[call.method];
        if (handler) {
          return { jsonrpc: "2.0", id: call.id, result: handler(call.params ?? []) };
        }
        return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "no" } };
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    setBlock: (n: number) => {
      block = n;
    },
  };
}

/** WS endpoint accepting eth_subscribe("newHeads") and pushing heads on demand. */
async function startWsMock(opts: { silentOn?: string[] } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      const req = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      if (req.method === "eth_subscribe") {
        // Simulate a server that silently drops unsupported subscriptions
        // instead of rejecting them (no response at all).
        if (opts.silentOn?.includes(req.params?.[0] as string)) return;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub1" }));
        return;
      }
      // Anything else (e.g. the eth_chainId availability probe): plain ok.
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0x1" }));
    });
  });
  await new Promise<void>((r) => wss.on("listening", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => r());
      }),
  );
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    socketCount: () => sockets.size,
    pushHead: (n: number, extra: Record<string, unknown> = {}) => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: {
          subscription: "0xsub1",
          result: { number: `0x${n.toString(16)}`, ...extra },
        },
      });
      for (const ws of sockets) ws.send(msg);
    },
    /** Kill the endpoint entirely: existing sockets die, reconnects refused. */
    kill: async () => {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

describe("newHeads subscription", () => {
  it("updates the pool chain head from newHeads notifications", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
      health,
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    expect(pool.chainHead).toBe(1000); // initial height from the HTTP poll
    expect(pool.status().upstreams[0]!.wsHealthy).toBe(true);
    await waitFor(() => ws.socketCount() === 1);

    ws.pushHead(1001);
    await waitFor(() => pool.chainHead === 1001);
    ws.pushHead(1005);
    await waitFor(() => pool.chainHead === 1005);
    // Height moved without any further HTTP poll.
  });

  it("falls back to HTTP polling when the upstream has no WS endpoint", async () => {
    const http = await startHttpMock(1000);
    // No wsUrl: the derived ws:// URL hits the plain HTTP server and fails.
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, weight: 1 }],
      health,
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    expect(pool.status().upstreams[0]!.wsHealthy).toBe(false);
    expect(pool.chainHead).toBe(1000);

    http.setBlock(1010);
    await pool.pollAll();
    expect(pool.chainHead).toBe(1010);
  });

  it("falls back to HTTP polling after the WS connection drops", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
      health,
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    await waitFor(() => ws.socketCount() === 1);
    ws.pushHead(1003);
    await waitFor(() => pool.chainHead === 1003);

    await ws.kill();
    await waitFor(() => pool.status().upstreams[0]!.wsHealthy === false);

    http.setBlock(1007);
    await pool.pollAll();
    expect(pool.chainHead).toBe(1007);
  });

  it("keeps the connection when a server silently ignores one subscription kind", async () => {
    const http = await startHttpMock(1000);
    // Never answers newPendingTransactions: the mirror feed stays unconfirmed.
    const ws = await startWsMock({ silentOn: ["newPendingTransactions"] });
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
      health,
      undefined,
      undefined,
      { mirror: true }, // txpool mirror -> two subscription kinds on one socket
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    await waitFor(() => ws.socketCount() === 1);
    // Well past the connect/subscribe timeout: the connection must survive
    // on the confirmed newHeads feed alone instead of flapping.
    await new Promise((r) => setTimeout(r, 6000));
    expect(ws.socketCount()).toBe(1);
    expect(pool.status().upstreams[0]!.wsHealthy).toBe(true);
    ws.pushHead(1011);
    await waitFor(() => pool.chainHead === 1011);
  }, 10000);

  it("keeps the connection alive with client-side ping enabled", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
      { ...health, wsPingIntervalMs: 50 },
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    await waitFor(() => ws.socketCount() === 1);
    // Stay connected well beyond several ping intervals (the mock pongs).
    await new Promise((r) => setTimeout(r, 300));
    expect(pool.status().upstreams[0]!.wsHealthy).toBe(true);
    ws.pushHead(1009);
    await waitFor(() => pool.chainHead === 1009);
  });

  it("does not subscribe when wsHeads is disabled; heads come from HTTP only", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const pool = new UpstreamPool(
      [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
      { ...health, wsHeads: false },
    );
    cleanups.push(async () => pool.stop());

    await pool.pollAll();
    // WS availability is still detected (per-poll probe) so client WS
    // forwarding keeps working, but no persistent subscription is held.
    expect(pool.status().upstreams[0]!.wsHealthy).toBe(true);
    await waitFor(() => ws.socketCount() === 0);

    ws.pushHead(1050); // nobody is subscribed: must have no effect
    http.setBlock(1004);
    await pool.pollAll();
    expect(pool.chainHead).toBe(1004);
  });
});

function makeConfig(upstream: { name: string; url: string; wsUrl?: string }): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    statusPagePath: "/",
    upstreams: [{ ...upstream, weight: 1 }],
    health: { ...health },
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
      maxBatchSize: 10,
      maxBodyBytes: 1048576,
      maxLogsRange: 100,
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
    reorg: { enabled: true, windowSize: 128 },
    cors: { enabled: true, origin: "*" },
  };
}

const BLOCK_1001 = {
  number: "0x3e9",
  hash: "0xaaa1001",
  parentHash: "0xparent",
  transactions: ["0xtx1", "0xtx2"],
  uncles: [],
  gasUsed: "0x5208",
};

describe("head cache warming", () => {
  async function makeWiredProxy(httpUrl: string, wsUrl: string) {
    const config = makeConfig({ name: "a", url: httpUrl, wsUrl });
    const pool = new UpstreamPool(config.upstreams, config.health);
    cleanups.push(async () => pool.stop());
    const cache = new ResponseCache(createCacheBackend(config.cache));
    // ProxyHandler self-registers on the pool's onNewHead for head recording
    // and cache warming — no extra wiring needed.
    const proxy = new ProxyHandler(pool, cache, config);
    await pool.pollAll();
    return { pool, proxy };
  }

  it("header-only notification: fetches the block once, then serves it from cache", async () => {
    const http = await startHttpMock(1000, {
      eth_getBlockByHash: () => BLOCK_1001,
      eth_getBlockByNumber: () => BLOCK_1001,
    });
    const ws = await startWsMock();
    const { proxy } = await makeWiredProxy(http.url, ws.url);
    await waitFor(() => ws.socketCount() === 1);

    ws.pushHead(1001, { hash: "0xaaa1001" }); // bare header, no transactions
    await waitFor(() => (http.hits.get("eth_getBlockByHash") ?? 0) === 1);
    await waitFor(() => proxy.cacheStats().sets >= 4);

    // Equivalent requests now hit the warmed cache: no further upstream calls.
    const byNumber = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(byNumber).toMatchObject({ id: 1, result: { hash: "0xaaa1001" } });
    const byHash = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByHash", params: ["0xaaa1001", false],
    });
    expect(byHash).toMatchObject({ id: 2, result: { number: "0x3e9" } });
    expect(http.hits.get("eth_getBlockByHash")).toBe(1);

    // fullTx=true was not warmed (we only have tx hashes): goes upstream.
    const full = await proxy.handle({
      jsonrpc: "2.0", id: 3, method: "eth_getBlockByNumber", params: ["0x3e9", true],
    });
    expect(full).toMatchObject({ id: 3, result: { hash: "0xaaa1001" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);
  });

  it("notification carrying transactions is cached directly without an upstream fetch", async () => {
    const http = await startHttpMock(1000, {
      eth_getBlockByNumber: () => BLOCK_1001,
    });
    const ws = await startWsMock();
    const { proxy } = await makeWiredProxy(http.url, ws.url);
    await waitFor(() => ws.socketCount() === 1);

    const fullTxBlock = {
      ...BLOCK_1001,
      number: "0x3ea",
      hash: "0xbbb1002",
      transactions: [{ hash: "0xtx1" }, { hash: "0xtx2" }],
    };
    ws.pushHead(1002, fullTxBlock);
    await waitFor(() => proxy.cacheStats().sets > 0);

    expect(http.hits.get("eth_getBlockByNumber") ?? 0).toBe(0);
    const full = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x3ea", true],
    });
    expect(full).toMatchObject({ id: 1, result: { hash: "0xbbb1002" } });
    // The false shape is derived from the full transactions.
    const plain = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByHash", params: ["0xbbb1002", false],
    });
    expect(plain).toMatchObject({
      id: 2,
      result: { hash: "0xbbb1002", transactions: ["0xtx1", "0xtx2"] },
    });
    expect(http.hits.get("eth_getBlockByNumber") ?? 0).toBe(0);
  });

  it("dedupes the same head announced by several upstreams", async () => {
    const http = await startHttpMock(1000, {
      eth_getBlockByHash: () => BLOCK_1001,
    });
    const config = makeConfig({ name: "a", url: http.url });
    const pool = new UpstreamPool(config.upstreams, config.health);
    cleanups.push(async () => pool.stop());
    const proxy = new ProxyHandler(
      pool,
      new ResponseCache(createCacheBackend(config.cache)),
      config,
    );
    await pool.pollAll();

    await proxy.warmBlockFromHead("a", { number: "0x3e9", hash: "0xaaa1001" });
    await proxy.warmBlockFromHead("a", { number: "0x3e9", hash: "0xaaa1001" });
    expect(http.hits.get("eth_getBlockByHash") ?? 0).toBe(1);
  });
});

describe("local block filters", () => {
  function makeProxyWith(config: Config, pool: UpstreamPool) {
    cleanups.push(async () => pool.stop());
    return new ProxyHandler(
      pool,
      new ResponseCache(createCacheBackend(config.cache)),
      config,
    );
  }

  it("serves eth_newBlockFilter locally from observed heads, no upstream calls", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const config = makeConfig({ name: "a", url: http.url, wsUrl: ws.url });
    const pool = new UpstreamPool(config.upstreams, config.health);
    const proxy = makeProxyWith(config, pool);
    await pool.pollAll();
    await waitFor(() => ws.socketCount() === 1);

    ws.pushHead(1001, { hash: "0xh1001" });
    await waitFor(() => pool.chainHead === 1001);

    const created = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_newBlockFilter", params: [],
    });
    const filterId = (created as { result: string }).result;
    expect(typeof filterId).toBe("string");
    // created locally: the upstream never saw it
    expect(http.hits.get("eth_newBlockFilter") ?? 0).toBe(0);

    ws.pushHead(1002, { hash: "0xh1002" });
    ws.pushHead(1003, { hash: "0xh1003" });
    await waitFor(() => pool.chainHead === 1003);

    const changes = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getFilterChanges", params: [filterId],
    });
    // only heads after creation, in ascending order
    expect(changes).toMatchObject({ id: 2, result: ["0xh1002", "0xh1003"] });

    // no new heads since the last poll
    const none = await proxy.handle({
      jsonrpc: "2.0", id: 3, method: "eth_getFilterChanges", params: [filterId],
    });
    expect(none).toMatchObject({ id: 3, result: [] });

    ws.pushHead(1004, { hash: "0xh1004" });
    await waitFor(() => pool.chainHead === 1004);
    const next = await proxy.handle({
      jsonrpc: "2.0", id: 4, method: "eth_getFilterChanges", params: [filterId],
    });
    expect(next).toMatchObject({ id: 4, result: ["0xh1004"] });

    const uninstalled = await proxy.handle({
      jsonrpc: "2.0", id: 5, method: "eth_uninstallFilter", params: [filterId],
    });
    expect(uninstalled).toMatchObject({ id: 5, result: true });

    const after = await proxy.handle({
      jsonrpc: "2.0", id: 6, method: "eth_getFilterChanges", params: [filterId],
    });
    expect(after).toMatchObject({ id: 6, error: { code: -32000 } });

    // All six filter calls were answered locally: create + 4 polls + uninstall.
    expect(proxy.localStats().filters).toBe(6);
  });

  it("counts locally answered eth_blockNumber in localStats", async () => {
    const http = await startHttpMock(1000);
    const config = makeConfig({ name: "a", url: http.url });
    const pool = new UpstreamPool(config.upstreams, config.health);
    const proxy = makeProxyWith(config, pool);
    await pool.pollAll();

    const before = proxy.localStats();
    const upstreamCallsBefore = http.hits.get("eth_blockNumber") ?? 0;
    const res = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [],
    });
    expect(res).toMatchObject({ id: 1, result: "0x3e8" });
    // The client request added no upstream call (the health poll's own
    // eth_blockNumber calls aside).
    expect(http.hits.get("eth_blockNumber") ?? 0).toBe(upstreamCallsBefore);

    const afterStats = proxy.localStats();
    expect(afterStats.blockNumber).toBe(before.blockNumber + 1);
    expect(afterStats.total).toBe(
      afterStats.cacheHits + afterStats.blockNumber + afterStats.filters,
    );
  });

  it("falls back to sticky routing when wsHeads is disabled", async () => {
    const http = await startHttpMock(1000, {
      eth_newBlockFilter: () => "0x1",
      eth_getFilterChanges: () => [],
    });
    const config = makeConfig({ name: "a", url: http.url });
    const pool = new UpstreamPool(config.upstreams, {
      ...config.health,
      wsHeads: false,
    });
    const proxy = makeProxyWith(config, pool);
    await pool.pollAll();

    const created = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_newBlockFilter", params: [],
    });
    const filterId = (created as { result: string }).result;
    // forwarded upstream (sticky path): node-local "0x1" got rewritten
    expect(filterId).not.toBe("0x1");
    expect(http.hits.get("eth_newBlockFilter")).toBe(1);

    const changes = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getFilterChanges", params: [filterId],
    });
    expect(changes).toMatchObject({ id: 2, result: [] });
    expect(http.hits.get("eth_getFilterChanges")).toBe(1);
  });
});
