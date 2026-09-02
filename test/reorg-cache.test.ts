import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config, HealthConfig } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import type { ReorgEvent } from "../src/reorg.js";

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
};

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * HTTP mock whose block answers follow a switchable "fork": block hashes are
 * `<forkTag><height>`, so flipping the tag simulates the chain re-mining
 * heights on a new branch after a reorg.
 */
async function startHttpMock(initialBlock: number) {
  let block = initialBlock;
  let fork = "0xa";
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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
        if (call.method === "eth_getBlockByNumber") {
          const n = call.params?.[0] as string;
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: {
              number: n,
              hash: `${fork}block${n}`,
              parentHash: "0xparent",
              transactions: [],
            },
          };
        }
        if (call.method === "eth_getTransactionReceipt") {
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: {
              transactionHash: (call.params?.[0] as string) ?? "0xtx",
              blockHash: `${fork}block0x3e9`,
              blockNumber: "0x3e9",
              status: "0x1",
            },
          };
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
    switchFork: (tag: string) => {
      fork = tag;
    },
  };
}

async function startWsMock() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      const req = JSON.parse(data.toString()) as { id: number; method: string };
      if (req.method === "eth_subscribe") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub1" }));
      }
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
    pushHead: (n: number, hash: string, parentHash: string) => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: {
          subscription: "0xsub1",
          result: { number: `0x${n.toString(16)}`, hash, parentHash },
        },
      });
      for (const ws of sockets) ws.send(msg);
    },
  };
}

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

async function startStack(reorgConfig?: { enabled: boolean; windowSize: number }) {
  const http = await startHttpMock(1000);
  const ws = await startWsMock();
  const config = makeConfig({ name: "a", url: http.url, wsUrl: ws.url });
  const pool = new UpstreamPool(
    config.upstreams,
    config.health,
    undefined,
    undefined,
    undefined,
    undefined,
    reorgConfig ?? config.reorg,
  );
  cleanups.push(async () => pool.stop());
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
  );
  const reorgs: ReorgEvent[] = [];
  pool.onReorg((e) => reorgs.push(e));
  await pool.pollAll();
  await waitFor(() => ws.socketCount() === 1);
  return { http, ws, pool, proxy, reorgs };
}

describe("reorg-validated cache entries", () => {
  it("invalidates a near-head eth_getBlockByNumber entry after a reorg", async () => {
    const { http, ws, pool, proxy, reorgs } = await startStack();

    // Canonical branch a: head 1001.
    ws.pushHead(1001, "0xablock0x3e9", "0xp1000");
    await waitFor(() => pool.chainHead === 1001);

    const first = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(first).toMatchObject({ id: 1, result: { hash: "0xablock0x3e9" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);

    // Second read comes from the cache.
    await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);

    // Reorg: 1001 is replaced by branch b, which then extends.
    http.switchFork("0xb");
    ws.pushHead(1001, "0xbblock0x3e9", "0xp1000");
    ws.pushHead(1002, "0xbblock0x3ea", "0xbblock0x3e9");
    await waitFor(() => reorgs.length === 1);

    // The stale entry is detected on read and refetched from upstream.
    const after = await proxy.handle({
      jsonrpc: "2.0", id: 3, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(after).toMatchObject({ id: 3, result: { hash: "0xbblock0x3e9" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(2);
  });

  it("invalidates a mined eth_getTransactionReceipt when its block is reorged", async () => {
    const { http, ws, pool, proxy, reorgs } = await startStack();
    ws.pushHead(1001, "0xablock0x3e9", "0xp1000");
    await waitFor(() => pool.chainHead === 1001);

    const first = await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: ["0xtx1"],
    });
    expect(first).toMatchObject({ id: 1, result: { blockHash: "0xablock0x3e9" } });
    expect(http.hits.get("eth_getTransactionReceipt")).toBe(1);

    // Cached permanently (mined receipt): second read is a cache hit.
    await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: ["0xtx1"],
    });
    expect(http.hits.get("eth_getTransactionReceipt")).toBe(1);

    // Reorg replaces block 1001; the receipt's blockHash is no longer canonical.
    http.switchFork("0xb");
    ws.pushHead(1001, "0xbblock0x3e9", "0xp1000");
    ws.pushHead(1002, "0xbblock0x3ea", "0xbblock0x3e9");
    await waitFor(() => reorgs.length === 1);

    const after = await proxy.handle({
      jsonrpc: "2.0", id: 3, method: "eth_getTransactionReceipt", params: ["0xtx1"],
    });
    expect(after).toMatchObject({ id: 3, result: { blockHash: "0xbblock0x3e9" } });
    expect(http.hits.get("eth_getTransactionReceipt")).toBe(2);
  });

  it("trusts entries the detector window cannot vouch for (null stamp)", async () => {
    const { http, ws, pool, proxy } = await startStack();
    // Window only covers 1001; a request for 999 is near-head per policy but
    // has no canonical hash to stamp with.
    ws.pushHead(1001, "0xablock0x3e9", "0xp1000");
    await waitFor(() => pool.chainHead === 1001);

    await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x3e7", false],
    });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);
    const again = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["0x3e7", false],
    });
    expect(again).toMatchObject({ id: 2, result: { hash: "0xablock0x3e7" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1); // served from cache
  });

  it("keeps finalized entries permanent and unstamped", async () => {
    const { http, ws, pool, proxy } = await startStack();
    ws.pushHead(1001, "0xablock0x3e9", "0xp1000");
    await waitFor(() => pool.chainHead === 1001);

    // Height 100 is beyond finalityDepth (64) below the head: permanent entry.
    await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x64", false],
    });
    const again = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["0x64", false],
    });
    expect(again).toMatchObject({ id: 2, result: { hash: "0xablock0x64" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);
  });

  it("does no validation when reorg detection is disabled", async () => {
    const { http, ws, pool, proxy, reorgs } = await startStack({
      enabled: false,
      windowSize: 128,
    });
    ws.pushHead(1001, "0xablock0x3e9", "0xp1000");
    await waitFor(() => pool.chainHead === 1001);

    await proxy.handle({
      jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);

    http.switchFork("0xb");
    ws.pushHead(1001, "0xbblock0x3e9", "0xp1000");
    ws.pushHead(1002, "0xbblock0x3ea", "0xbblock0x3e9");
    await new Promise((r) => setTimeout(r, 100));
    expect(reorgs).toHaveLength(0);

    // No detector -> no validation: the stale entry is still served.
    const after = await proxy.handle({
      jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["0x3e9", false],
    });
    expect(after).toMatchObject({ id: 2, result: { hash: "0xablock0x3e9" } });
    expect(http.hits.get("eth_getBlockByNumber")).toBe(1);
  });
});
