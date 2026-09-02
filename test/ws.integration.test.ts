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
    statusPagePath: "/",
    upstreams: [{ ...upstream, weight: 1 }],
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 500,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      wsHeads: true,
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
  /** Broadcast a raw message (e.g. an eth_subscription notification). */
  push: (msg: unknown) => void;
}

/**
 * WS endpoint: answers eth_subscribe with incrementing subscription ids and
 * pushes one eth_subscription notification each; eth_unsubscribe returns
 * true; other methods get `ok:<method>`. Ids are per-connection (each
 * connection is an independent subscription namespace — the pool's own
 * newHeads subscription lives on a separate connection).
 * With autoPush=false nothing is pushed automatically; use push() instead.
 */
async function startWsMock(autoPush = true): Promise<WsMock> {
  const received: string[] = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    let subCounter = 0;
    ws.on("message", (data) => {
      const text = data.toString();
      received.push(text);
      const req = JSON.parse(text) as { id: number; method: string; params?: unknown[] };
      if (req.method === "eth_subscribe") {
        // Distinct ids for the mirror feeds so tests can target them.
        const subId =
          req.params?.[0] === "newPendingTransactions"
            ? "0xpending"
            : req.params?.[0] === "syncing"
              ? "0xsyncing"
              : `0xsub${++subCounter}`;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: subId }));
        if (autoPush) {
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "eth_subscription",
                params: { subscription: subId, result: { number: "0x3e8" } },
              }),
            );
          }, 30);
        }
        return;
      }
      if (req.method === "eth_unsubscribe") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `ok:${req.method}` }));
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => r());
      }),
  );
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    push: (msg: unknown) => {
      const text = JSON.stringify(msg);
      for (const ws of sockets) ws.send(text);
    },
  };
}

async function makeApp(
  upstream: { url: string; wsUrl?: string },
  tweak?: (config: Config) => void,
) {
  const config = baseConfig({ name: "a", ...upstream });
  tweak?.(config);
  const pool = new UpstreamPool(
    config.upstreams,
    config.health,
    undefined,
    undefined,
    config.txpool,
    config.syncing,
  );
  await pool.pollAll();
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
  return { port, pool, proxy };
}

/** Collect the next `count` messages from a client socket. */
function collect(
  client: WebSocket,
  count: number,
  trigger?: () => void,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  return new Promise((resolve, reject) => {
    client.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) resolve(messages);
    });
    client.on("error", reject);
    setTimeout(() => reject(new Error("timeout waiting for ws messages")), 5000);
    trigger?.();
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
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

  it("forwards non-newHeads eth_subscribe over a pinned upstream connection and relays notifications", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = collect(client, 2);
    client.on("open", () => {
      // logs subscriptions stay on the pinned-upstream path (only newHeads
      // is served locally)
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_subscribe", params: ["logs", { address: "0xaaa" }] }));
    });
    const [subResponse, notification] = await messages;

    // the upstream-assigned subscription id is passed through with the client's request id
    expect(subResponse).toMatchObject({ id: 9, result: "0xsub1" });
    expect(notification).toMatchObject({
      method: "eth_subscription",
      params: { subscription: "0xsub1", result: { number: "0x3e8" } },
    });
    // two upstream subscribe frames on separate connections: the pool's own
    // newHeads subscription (kept alive for head tracking) + the client's
    expect(ws.received.filter((m) => m.includes("eth_subscribe"))).toHaveLength(2);
    client.close();
  });

  it("answers -32002 for subscriptions when no WS-capable upstream exists", async () => {
    // Upstream unreachable at both HTTP and WS level; wsHeads disabled so
    // newHeads also takes the pinned-upstream path.
    const { port } = await makeApp({ url: "http://127.0.0.1:1" }, (config) => {
      config.health.wsHeads = false;
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = collect(client, 1);
    client.on("open", () => {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    });
    const [res] = await messages;
    expect(res).toMatchObject({ id: 1, error: { code: -32002 } });
    client.close();
  });

  it("rate limits WS messages per client IP", async () => {
    const http = await startHttpMock(1000);
    const { port } = await makeApp({ url: http.url }, (config) => {
      config.rateLimit.enabled = true;
      config.rateLimit.wsMessagesPerSecond = 1;
      config.rateLimit.wsBurst = 1;
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = collect(client, 2);
    client.on("open", () => {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xaaa", "latest"] }));
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xaaa", "latest"] }));
    });
    const [a, b] = await messages;
    const byId = new Map([a, b].map((m) => [(m as { id: number }).id, m]));
    expect(byId.get(1)).toMatchObject({ result: "0x1" });
    expect(byId.get(2)).toMatchObject({ error: { code: -32005 } });
    client.close();
  });

  it("limits concurrent subscriptions per client IP and frees slots on unsubscribe", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock();
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url }, (config) => {
      config.rateLimit.maxSubscriptionsPerIp = 2;
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((r) => client.on("open", r));

    const call = (id: number, method: string, params: unknown[] = []) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        const onMsg = (data: WebSocket.RawData): void => {
          const msg = JSON.parse(data.toString()) as { id?: number };
          if (msg.id === id) {
            client.off("message", onMsg);
            clearTimeout(timer);
            resolve(msg as Record<string, unknown>);
          }
        };
        client.on("message", onMsg);
        client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });

    // newHeads is served locally (pool tracks heads itself): proxy-issued ids
    const sub1 = (await call(1, "eth_subscribe", ["newHeads"])) as { result: string };
    const sub2 = (await call(2, "eth_subscribe", ["newHeads"])) as { result: string };
    expect(typeof sub1.result).toBe("string");
    expect(typeof sub2.result).toBe("string");
    expect(sub1.result).not.toBe(sub2.result);
    // third subscription exceeds the per-IP cap of 2
    expect(await call(3, "eth_subscribe", ["newHeads"])).toMatchObject({
      error: { code: -32005 },
    });
    // unsubscribing frees a slot
    expect(await call(4, "eth_unsubscribe", [sub1.result])).toMatchObject({ result: true });
    expect(await call(5, "eth_subscribe", ["newHeads"])).toMatchObject({
      result: expect.any(String),
    });

    client.close();
  });

  it("serves newHeads locally and fans out pool-observed heads to every subscriber", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock(false); // heads pushed manually below
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });

    const subscribe = async (client: WebSocket, id: number): Promise<string> => {
      const [res] = await collect(client, 1, () =>
        client.send(
          JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params: ["newHeads"] }),
        ),
      );
      return (res as { result: string }).result;
    };

    const a = new WebSocket(`ws://127.0.0.1:${port}/`);
    const b = new WebSocket(`ws://127.0.0.1:${port}/`);
    await Promise.all([
      new Promise<void>((r) => a.on("open", r)),
      new Promise<void>((r) => b.on("open", r)),
    ]);
    const subA = await subscribe(a, 1);
    const subB = await subscribe(b, 1);
    expect(subA).not.toBe(subB);

    // Nothing was forwarded upstream beyond the pool's own subscription.
    expect(ws.received.filter((m) => m.includes("eth_subscribe"))).toHaveLength(1);

    const headsA: unknown[] = [];
    const headsB: unknown[] = [];
    a.on("message", (d) => headsA.push(JSON.parse(d.toString())));
    b.on("message", (d) => headsB.push(JSON.parse(d.toString())));

    ws.push({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "0xsub1", result: { number: "0x3e9", hash: "0xh1" } },
    });
    await waitFor(() => headsA.length === 1 && headsB.length === 1);
    expect(headsA[0]).toMatchObject({
      method: "eth_subscription",
      params: { subscription: subA, result: { number: "0x3e9", hash: "0xh1" } },
    });
    expect(headsB[0]).toMatchObject({
      method: "eth_subscription",
      params: { subscription: subB, result: { number: "0x3e9", hash: "0xh1" } },
    });

    // A duplicate announcement of the same hash is not fanned out again.
    ws.push({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "0xsub1", result: { number: "0x3e9", hash: "0xh1" } },
    });

    // After A unsubscribes, only B gets the next head.
    const [unsubRes] = await collect(a, 1, () =>
      a.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_unsubscribe", params: [subA] })),
    );
    expect(unsubRes).toMatchObject({ id: 2, result: true });

    ws.push({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "0xsub1", result: { number: "0x3ea", hash: "0xh2" } },
    });
    await waitFor(() => headsB.length === 2);
    expect(headsB[1]).toMatchObject({
      params: { subscription: subB, result: { number: "0x3ea" } },
    });
    expect(headsA.filter((m: any) => m.method === "eth_subscription")).toHaveLength(1);

    a.close();
    b.close();
  });

  it("serves newPendingTransactions locally when the txpool mirror is enabled", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock(false);
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url }, (config) => {
      config.txpool.mirror = true;
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((r) => client.on("open", r));
    const [subRes] = await collect(client, 1, () =>
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions"] }),
      ),
    );
    const subId = (subRes as { result: string }).result;
    expect(typeof subId).toBe("string");
    expect(subId).not.toBe("0xpending"); // proxy-issued, not upstream's

    // The client subscription never touched the upstream: only the pool's own
    // newHeads + newPendingSubscriptions feeds are on the wire.
    expect(
      ws.received.filter((m) => m.includes("newPendingTransactions")),
    ).toHaveLength(1);

    const notifs: { params?: { result?: unknown } }[] = [];
    client.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.method === "eth_subscription") notifs.push(m);
    });

    const pushTx = (hash: string) =>
      ws.push({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: "0xpending", result: hash },
      });

    pushTx("0xtxhash1");
    await waitFor(() => notifs.length === 1);
    expect(notifs[0]).toMatchObject({
      params: { subscription: subId, result: "0xtxhash1" },
    });

    // Duplicate announcement (e.g. another upstream saw the same tx) is
    // deduped; a new hash goes through.
    pushTx("0xtxhash1");
    pushTx("0xtxhash2");
    await waitFor(() => notifs.length === 2);
    expect(notifs[1]).toMatchObject({
      params: { subscription: subId, result: "0xtxhash2" },
    });

    client.close();
  });

  it("passes newPendingTransactions through upstream when the mirror is disabled", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock(false);
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((r) => client.on("open", r));
    const [subRes] = await collect(client, 1, () =>
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions"] }),
      ),
    );
    // pinned-upstream path: the upstream-assigned id is passed through
    expect(subRes).toMatchObject({ id: 1, result: "0xpending" });

    client.close();
  });

  it("serves syncing locally when the syncing mirror is enabled", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock(false);
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url }, (config) => {
      config.syncing.mirror = true;
    });

    // The pool's own syncing feed reports the initial status (not syncing).
    ws.push({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "0xsyncing", result: false },
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((r) => client.on("open", r));
    // Subscribe response + the immediate current-status notification,
    // mirroring how a node answers eth_subscribe("syncing").
    const [subRes, firstNotif] = await collect(client, 2, () =>
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["syncing"] }),
      ),
    );
    const subId = (subRes as { result: string }).result;
    expect(typeof subId).toBe("string");
    expect(subId).not.toBe("0xsyncing"); // proxy-issued, not upstream's
    expect(firstNotif).toMatchObject({
      method: "eth_subscription",
      params: { subscription: subId, result: false },
    });

    // The client subscription never touched the upstream: only the pool's
    // own syncing feed is on the wire.
    expect(ws.received.filter((m) => m.includes('"syncing"'))).toHaveLength(1);

    const notifs: { params?: { result?: unknown } }[] = [];
    client.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.method === "eth_subscription") notifs.push(m);
    });

    const progress = { startingBlock: "0x3e8", currentBlock: "0x400", highestBlock: "0x7d0" };
    const pushStatus = (result: unknown) =>
      ws.push({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: "0xsyncing", result },
      });

    pushStatus(progress);
    await waitFor(() => notifs.length === 1);
    expect(notifs[0]).toMatchObject({ params: { subscription: subId, result: progress } });

    // An identical re-announcement is deduped; a real change goes through.
    pushStatus(progress);
    pushStatus(false);
    await waitFor(() => notifs.length === 2);
    expect(notifs[1]).toMatchObject({ params: { subscription: subId, result: false } });

    client.close();
  });

  it("passes syncing through upstream when the mirror is disabled", async () => {
    const http = await startHttpMock(1000);
    const ws = await startWsMock(false);
    const { port } = await makeApp({ url: http.url, wsUrl: ws.url });

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((r) => client.on("open", r));
    const [subRes] = await collect(client, 1, () =>
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["syncing"] }),
      ),
    );
    // pinned-upstream path: the upstream-assigned id is passed through
    expect(subRes).toMatchObject({ id: 1, result: "0xsyncing" });

    client.close();
  });
});
