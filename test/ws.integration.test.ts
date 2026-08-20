import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import { buildServer } from "../src/server.js";
import { deriveWsUrl } from "../src/ws-proxy.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** HTTP endpoint so the pool can poll the node's health. */
async function startHttpMock(block = 1000): Promise<string> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string }[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies = list.map((c) => {
        if (c.method === "eth_syncing") return { jsonrpc: "2.0", id: c.id, result: false };
        if (c.method === "eth_blockNumber") return { jsonrpc: "2.0", id: c.id, result: `0x${block.toString(16)}` };
        if (c.method === "eth_chainId") return { jsonrpc: "2.0", id: c.id, result: "0x1" };
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "nf" } };
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replies));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** WS endpoint that answers every request with `result: "ok:<method>"`. */
async function startWsMock(received: string[]): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const text = data.toString();
      received.push(text);
      const req = JSON.parse(text) as { id: number; method: string };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `ok:${req.method}` }));
    });
  });
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
  const { port } = wss.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

async function makeApp(wsUrl?: string) {
  const httpUrl = await startHttpMock();
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    upstreams: [{ name: "a", url: httpUrl, wsUrl, weight: 1 }],
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 2000,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
    },
    cache: {
      backend: "memory",
      shortTtlMs: 60000,
      pendingTtlMs: 1000,
      finalityDepth: 64,
      memory: { maxEntries: 1000 },
    },
  };
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
  return { port, pool };
}

describe("deriveWsUrl", () => {
  it("swaps http(s) for ws(s)", () => {
    expect(deriveWsUrl("http://node:8545")).toBe("ws://node:8545/");
    expect(deriveWsUrl("https://node.example/rpc")).toBe("wss://node.example/rpc");
  });
});

describe("WebSocket forwarding", () => {
  it("relays frames in both directions, including messages sent before the upstream is open", async () => {
    const received: string[] = [];
    const wsUrl = await startWsMock(received);
    const { port } = await makeApp(wsUrl);

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const response = await new Promise<string>((resolve, reject) => {
      client.on("open", () => {
        // Sent immediately: the proxy-side upstream socket is still
        // CONNECTING, so this exercises the pending-frame buffer.
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      });
      client.on("message", (data) => resolve(data.toString()));
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout waiting for ws response")), 5000);
    });

    expect(JSON.parse(response)).toEqual({ jsonrpc: "2.0", id: 1, result: "ok:eth_subscribe" });
    expect(received).toHaveLength(1);
    client.close();
  });

  it("closes with 1011 when no healthy upstream is available", async () => {
    // Point the upstream at an unreachable port: polling fails, the node
    // never becomes healthy, and no eligible upstream exists.
    const config: Config = {
      listen: { host: "127.0.0.1", port: 0 },
      upstreams: [{ name: "dead", url: "http://127.0.0.1:1", weight: 1 }],
      health: {
        pollIntervalMs: 60000,
        requestTimeoutMs: 500,
        maxBlockLag: 5,
        failureThreshold: 2,
        maxRetries: 2,
      },
      cache: {
        backend: "memory",
        shortTtlMs: 60000,
        pendingTtlMs: 1000,
        finalityDepth: 64,
        memory: { maxEntries: 1000 },
      },
    };
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

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const closeCode = await new Promise<number>((resolve) => {
      client.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1011);
  });
});
