import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import type { Config } from "../src/config.js";
import { StickyFilterRouter } from "../src/filters.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";

interface MockNode {
  url: string;
  hits: Map<string, number>;
  lastParams: Map<string, unknown[]>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/**
 * Mock node: every eth_new*Filter returns the same node-local id "0x1",
 * which is exactly why the proxy must rewrite ids before routing on them.
 */
async function startMockNode(
  block: number,
  handlers: Record<string, (params: unknown[]) => unknown> = {},
): Promise<MockNode> {
  const hits = new Map<string, number>();
  const lastParams = new Map<string, unknown[]>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed:
        | { id: number | string; method: string; params?: unknown[] }
        | { id: number | string; method: string; params?: unknown[] }[];
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies = list.map((call) => {
        hits.set(call.method, (hits.get(call.method) ?? 0) + 1);
        lastParams.set(call.method, call.params ?? []);
        if (call.method === "eth_syncing") {
          return { jsonrpc: "2.0", id: call.id, result: false };
        }
        if (call.method === "eth_blockNumber") {
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
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, lastParams };
}

async function makeProxy(nodes: MockNode[], stickyTtlMs = 300000) {
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    statusPagePath: "/",
    upstreams: nodes.map((n, i) => ({
      name: `node-${i}`,
      url: n.url,
      weight: 1,
    })),
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 2000,
      maxBlockLag: 5,
      failureThreshold: 2,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      wsHeads: true,
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
    filters: { stickyTtlMs },
    txpool: { mirror: false },
    syncing: { mirror: false },
    reorg: { enabled: true, windowSize: 128 },
    cors: { enabled: true, origin: "*" },
  };
  const pool = new UpstreamPool(config.upstreams, config.health);
  await pool.pollAll();
  const proxy = new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
    new StickyFilterRouter(stickyTtlMs),
  );
  return { proxy };
}

const NEW_FILTER = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "eth_newFilter",
  params: [{ fromBlock: "latest" }],
};

function poll(id: number, filterId: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "eth_getFilterChanges",
    params: [filterId],
  };
}

describe("sticky filter routing", () => {
  it("rewrites the node-local filter id to a unique proxy id", async () => {
    const node = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => [],
    });
    const { proxy } = await makeProxy([node]);

    const first = await proxy.handle({ ...NEW_FILTER, id: 1 });
    const second = await proxy.handle({ ...NEW_FILTER, id: 2 });

    expect(first).not.toMatchObject({ result: "0x1" });
    expect(second).not.toMatchObject({ result: "0x1" });
    const idA = (first as { result: string }).result;
    const idB = (second as { result: string }).result;
    expect(typeof idA).toBe("string");
    expect(idA).not.toBe(idB);
  });

  it("pins polling to the upstream that created the filter, with the node-local id", async () => {
    const a = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => ["log-a"],
    });
    const b = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => ["log-b"],
    });
    const { proxy } = await makeProxy([a, b]);

    const created = await proxy.handle(NEW_FILTER);
    const proxyId = (created as { result: string }).result;
    const owner = (a.hits.get("eth_newFilter") ?? 0) > 0 ? a : b;
    const other = owner === a ? b : a;

    for (let i = 0; i < 4; i++) {
      const res = await proxy.handle(poll(10 + i, proxyId));
      expect(res).toMatchObject({ id: 10 + i });
    }

    expect(owner.hits.get("eth_getFilterChanges")).toBe(4);
    expect(other.hits.get("eth_getFilterChanges") ?? 0).toBe(0);
    // The upstream sees its own node-local id, not the proxy id.
    expect(owner.lastParams.get("eth_getFilterChanges")).toEqual(["0x1"]);
  });

  it("rejects unknown filter ids without touching any upstream", async () => {
    const node = await startMockNode(1000, { eth_getFilterChanges: () => [] });
    const { proxy } = await makeProxy([node]);

    const res = await proxy.handle(poll(1, "0xdeadbeef"));
    expect(res).toMatchObject({
      id: 1,
      error: { code: -32000, message: "filter not found" },
    });
    expect(node.hits.get("eth_getFilterChanges") ?? 0).toBe(0);
  });

  it("uninstalls on the owning node and drops the mapping", async () => {
    const node = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => [],
      eth_uninstallFilter: () => true,
    });
    const { proxy } = await makeProxy([node]);

    const created = await proxy.handle(NEW_FILTER);
    const proxyId = (created as { result: string }).result;

    const uninstalled = await proxy.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_uninstallFilter",
      params: [proxyId],
    });
    expect(uninstalled).toMatchObject({ result: true });
    expect(node.lastParams.get("eth_uninstallFilter")).toEqual(["0x1"]);

    const after = await proxy.handle(poll(3, proxyId));
    expect(after).toMatchObject({ error: { code: -32000 } });
  });

  it("expires mappings after the sticky TTL", async () => {
    const node = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => [],
    });
    const { proxy } = await makeProxy([node], 30);

    const created = await proxy.handle(NEW_FILTER);
    const proxyId = (created as { result: string }).result;

    await new Promise((r) => setTimeout(r, 60));
    const res = await proxy.handle(poll(2, proxyId));
    expect(res).toMatchObject({ error: { code: -32000 } });
  });

  it("handles filter calls inside a batch alongside normal calls", async () => {
    const a = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => [],
      eth_gasPrice: () => "0x3b9aca00",
    });
    const b = await startMockNode(1000, {
      eth_newFilter: () => "0x1",
      eth_getFilterChanges: () => [],
      eth_gasPrice: () => "0x3b9aca00",
    });
    const { proxy } = await makeProxy([a, b]);

    const created = await proxy.handle(NEW_FILTER);
    const proxyId = (created as { result: string }).result;

    const res = (await proxy.handle([
      { jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] },
      poll(2, proxyId),
      poll(3, "0xdeadbeef"),
    ])) as unknown[];

    expect(res[0]).toMatchObject({ id: 1, result: "0x3b9aca00" });
    expect(res[1]).toMatchObject({ id: 2, result: [] });
    expect(res[2]).toMatchObject({ id: 3, error: { code: -32000 } });
  });
});
