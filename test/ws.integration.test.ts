import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import { buildServer } from "../src/server.js";
import { deriveWsUrl } from "../src/upstream.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function baseConfig(upstream: {
  name: string;
  url: string;
  wsUrl?: string;
}): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    upstreams: [{ ...upstream, weight: 1 }],
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 500,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    },
    cache: {
      backend: "memory",
      shortTtlMs: 60000,
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
  };
}

/** HTTP endpoint so the pool can poll health and serve regular RPC calls. */
async function startHttpMock(
  block = 1000,
): Promise<{ url: string; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: { id: number; method: string }[];
      try {
        parsed = JSON.parse(body) as { id: number; method: string }[];
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies = list.map((c) => {
        hits.set(c.method, (hits.get(c.method) ?? 0) + 1);
        if (c.method === "eth_syncing") return { jsonrpc: "2.0", id: c.id, result: false };
        if (c.method === "eth_blockNumber") return { jsonrpc: "2.0", id: c.id, result: `0x${block.toString(16)}` };
        if (c.method === "eth_chainId") return { jsonrpc: "2.0", id: c.id, result: "0x1" };
        if (c.method === "eth_getBalance") return { jsonrpc: "2.0", id: c.id, result: "0x1" };
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "nf" } };
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replies));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits };
}

interface WsMock {
  url: string;
  received: string[];
}

/**
 * WS endpoint: answers eth_subscribe with a fixed subscription id and pushes
 * one eth_subscription notification; other methods get `ok:<method>`.
 */
async function startWsMock(): Promise<WsMock> {
  const received: string[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const text = data.toString();
      received.push(text);
      const req = JSON.parse(text) as { id: number; method: string };
      if (req.method === "eth_subscribe") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub1" }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_subscription",
              params: { subscription: "0xsub1", result: { number: "0x3e8" } },
            }),
          );
        }, 30);
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `ok:${req.method}` }));
    });
  });
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
  const { port } = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, received };
}

async function makeApp(upstream: { url: string; wsUrl?: string }) {
  const config = baseConfig({ name: "a", ...upstream });
  const pool = new UpstreamPool(config.upstreams, config.health);
  await pool.pollAll();
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
  );
  const app = await buildServer(proxy, pool, config);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return { port, pool, proxy };
}

/** Collect the next `count` messages from a client socket. */
function collect(client: WebSocket, count: number): Promise<unknown[]> {
  const messages: unknown[] = [];
  return new Promise((resolve, reject) => {
    client.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) resolve(messages);
    });
    client.on("error", reject);
    setTimeout(() => reject(new Error("timeout waiting for ws messages")), 5000);
  });
}

describe("deriveWsUrl", () => {
  it("swaps http(s) for ws(s)", () => {
    expect(deriveWsUrl("http://node:8545")).toBe("ws://node:8545/");
    expect(deriveWsUrl("https://node.example/rpc")).toBe("wss://node.example/rpc");
  });
});

describe("WebSocket handling", () => {
  it("routes regular JSON-RPC over WS through the proxy pipeline (with caching)", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });
    const baseline = http.hits.get("eth_getBalance") ?? 0;
    // the pool's WS probe during pollAll() already talked to the mock
    ws.received.length = 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const responses = collect(client, 2);
    client.on("open", () => {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xaaa", "latest"] }));
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xaaa", "latest"] }));
    });
    const [first, second] = await responses;

    expect(first).toMatchObject({ id: 1, result: "0x1" });
    expect(second).toMatchObject({ id: 2, result: "0x1" });
    // second call was served from cache (or single-flight): one upstream call
    expect(http.hits.get("eth_getBalance")).toBe(baseline + 1);
    // nothing was forwarded to the WS endpoint
    expect(ws.received).toHaveLength(0);
    client.close();
  });

  it("forwards eth_subscribe over a pinned upstream connection and relays notifications", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = collect(client, 2);
    client.on("open", () => {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_subscribe", params: ["newHeads"] }));
    });
    const [subResponse, notification] = await messages;

    // the upstream-assigned subscription id is passed through with the client's request id
    expect(subResponse).toMatchObject({ id: 9, result: "0xsub1" });
    expect(notification).toMatchObject({
      method: "eth_subscription",
      params: { subscription: "0xsub1", result: { number: "0x3e8" } },
    });
    // exactly one upstream frame: the subscribe call (plus pool probe, cleared above)
    expect(ws.received.filter((m) => m.includes("eth_subscribe"))).toHaveLength(1);
    client.close();
  });

  it("answers -32002 for subscriptions when no WS-capable upstream exists", async () => {
    // Upstream unreachable at both HTTP and WS level.
    const { port } = await makeApp({ url: "http://127.0.0.1:1" });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = collect(client, 1);
    client.on("open", () => {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    });
    const [res] = await messages;
    expect(res).toMatchObject({ id: 1, error: { code: -32002 } });
    client.close();
  });
});
