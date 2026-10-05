import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseCache, createCacheBackend } from "../src/cache/index.js";
import { loadConfig, type Config, type UpstreamConfig } from "../src/config.js";
import { StickyFilterRouter } from "../src/filters.js";
import { UpstreamPool } from "../src/pool.js";
import { ProxyHandler } from "../src/proxy.js";
import type { JsonRpcResponse } from "../src/rpc.js";
import { methodMatchesPattern, Upstream } from "../src/upstream.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function isPoll(parsed: unknown): boolean {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.some((c) => (c as { method?: string } | null)?.method === "eth_syncing");
}

function pollReply(parsed: unknown): string {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = list.map((c) => {
    const call = c as { id: number; method: string };
    if (call.method === "eth_syncing") return { jsonrpc: "2.0", id: call.id, result: false };
    if (call.method === "eth_blockNumber") return { jsonrpc: "2.0", id: call.id, result: "0x64" };
    if (call.method === "eth_chainId") return { jsonrpc: "2.0", id: call.id, result: "0x1" };
    return { jsonrpc: "2.0", id: call.id, result: null };
  });
  return JSON.stringify(Array.isArray(parsed) ? out : out[0]);
}

/**
 * Mock node that 403s receipt requests (like publicnode's free tier) yet
 * serves everything else, so we can prove the proxy routes around it.
 */
async function startMock(opts: { receipt403?: boolean } = {}): Promise<{
  url: string;
  receiptCalls: number;
  otherCalls: number;
}> {
  let receiptCalls = 0;
  let otherCalls = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const out = [];
      let rejected = false;
      for (const c of list) {
        if (c.method === "eth_getTransactionReceipt") {
          receiptCalls += 1;
          if (opts.receipt403) {
            rejected = true;
            break;
          }
        } else if (!isPoll(parsed)) {
          otherCalls += 1;
        }
        if (c.method === "eth_syncing") { out.push({ jsonrpc: "2.0", id: c.id, result: false }); continue; }
        if (c.method === "eth_blockNumber") { out.push({ jsonrpc: "2.0", id: c.id, result: "0x64" }); continue; }
        if (c.method === "eth_chainId") { out.push({ jsonrpc: "2.0", id: c.id, result: "0x1" }); continue; }
        out.push({ jsonrpc: "2.0", id: c.id, result: "0xok" });
      }
      if (rejected) {
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: list[0].id,
              error: { code: -32602, message: "Archive requests require a personal token" },
            }),
          );
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get receiptCalls() {
      return receiptCalls;
    },
    get otherCalls() {
      return otherCalls;
    },
  };
}

function makeConfig(upstreams: UpstreamConfig[]): Config {
  return {
    listen: { host: "127.0.0.1", port: 8545 },
    statusPagePath: "/",
    upstreams,
    health: {
      pollIntervalMs: 60000,
      requestTimeoutMs: 2000,
      maxBlockLag: 999,
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

async function startStack(upstreams: UpstreamConfig[]): Promise<ProxyHandler> {
  const config = makeConfig(upstreams);
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
  return new ProxyHandler(
    pool,
    new ResponseCache(createCacheBackend(config.cache)),
    config,
    new StickyFilterRouter(config.filters.stickyTtlMs),
  );
}

const RPC = (id: number, method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

describe("methodMatchesPattern", () => {
  it("matches exact names and namespace globs", () => {
    expect(methodMatchesPattern("eth_call", "eth_call")).toBe(true);
    expect(methodMatchesPattern("eth_call", "eth_getBalance")).toBe(false);
    expect(methodMatchesPattern("debug_traceCall", "debug_*")).toBe(true);
    expect(methodMatchesPattern("debug_", "debug_*")).toBe(true);
    expect(methodMatchesPattern("eth_getBalance", "debug_*")).toBe(false);
  });
});

describe("Upstream.canServeMethods", () => {
  const mk = (methods?: UpstreamConfig["methods"]) =>
    new Upstream({ name: "u", url: "http://127.0.0.1:1", weight: 1, methods }, 1000);

  it("allows everything without configuration", () => {
    expect(mk().canServeMethods(["eth_call"])).toBe(true);
  });

  it("deny excludes matching methods", () => {
    const u = mk({ deny: ["eth_getTransactionReceipt"] });
    expect(u.canServeMethods(["eth_call"])).toBe(true);
    expect(u.canServeMethods(["eth_getTransactionReceipt"])).toBe(false);
    // Batch semantics: one denied member disqualifies the whole request.
    expect(u.canServeMethods(["eth_call", "eth_getTransactionReceipt"])).toBe(false);
  });

  it("allow admits only matching methods", () => {
    const u = mk({ allow: ["eth_call", "eth_getLogs"] });
    expect(u.canServeMethods(["eth_call"])).toBe(true);
    expect(u.canServeMethods(["eth_getLogs"])).toBe(true);
    expect(u.canServeMethods(["eth_getTransactionReceipt"])).toBe(false);
    expect(u.canServeMethods(["eth_call", "eth_getBalance"])).toBe(false);
  });

  it("deny wins over allow", () => {
    const u = mk({ allow: ["eth_*"], deny: ["eth_getTransactionReceipt"] });
    expect(u.canServeMethods(["eth_call"])).toBe(true);
    expect(u.canServeMethods(["eth_getTransactionReceipt"])).toBe(false);
  });
});

describe("integration: routing around a method restriction", () => {
  it("skips a receipt-restricted upstream instead of failing over", async () => {
    const restricted = await startMock({ receipt403: true }); // like publicnode
    const open = await startMock({});
    const proxy = await startStack([
      {
        name: "restricted",
        url: restricted.url,
        weight: 1,
        methods: { deny: ["eth_getTransactionReceipt"] },
      },
      { name: "open", url: open.url, weight: 1 },
    ]);

    // Receipts must go to the open upstream exclusively.
    for (let i = 0; i < 6; i++) {
      const r = (await proxy.handle(
        RPC(i, "eth_getTransactionReceipt", ["0x" + i.toString(16).padStart(64, "0")]),
      )) as JsonRpcResponse;
      expect(r.error).toBeUndefined();
    }
    expect(restricted.receiptCalls).toBe(0);
    expect(open.receiptCalls).toBe(6);

    // A method the restricted upstream does serve may still use it.
    const ok = (await proxy.handle(RPC(100, "eth_call", []))) as JsonRpcResponse;
    expect(ok.error).toBeUndefined();
  });

  it("does not fail a batch that mixes a restricted method with allowed ones", async () => {
    const restricted = await startMock({ receipt403: true });
    const open = await startMock({});
    const proxy = await startStack([
      {
        name: "restricted",
        url: restricted.url,
        weight: 1,
        methods: { deny: ["eth_getTransactionReceipt"] },
      },
      { name: "open", url: open.url, weight: 1 },
    ]);

    const res = (await proxy.handle([
      RPC(1, "eth_getTransactionReceipt", ["0x" + "a".repeat(64)]),
      RPC(2, "eth_getBalance", []),
    ])) as JsonRpcResponse[];
    expect(res).toHaveLength(2);
    expect(res[0]!.error).toBeUndefined();
    expect(res[1]!.error).toBeUndefined();
    // The restricted upstream never saw the batch (its deny covered one item).
    expect(restricted.receiptCalls).toBe(0);
  });

  it("keeps failing over when no method-allowed upstream has the block", async () => {
    // Both upstreams deny receipts -> the request has no candidate.
    const a = await startMock({ receipt403: true });
    const b = await startMock({ receipt403: true });
    const proxy = await startStack([
      { name: "a", url: a.url, weight: 1, methods: { deny: ["eth_getTransactionReceipt"] } },
      { name: "b", url: b.url, weight: 1, methods: { deny: ["eth_getTransactionReceipt"] } },
    ]);
    const r = (await proxy.handle(
      RPC(1, "eth_getTransactionReceipt", ["0x" + "b".repeat(64)]),
    )) as JsonRpcResponse;
    expect(r.error?.message).toMatch(/no healthy upstream/);
  });
});

describe("config: upstream method lists", () => {
  function writeConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ethproxy-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, body);
    return path;
  }

  it("parses allow/deny lists", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    methods:
      deny: [eth_getTransactionReceipt, debug_*]
`);
    const config = loadConfig(path);
    expect(config.upstreams[0]!.methods).toEqual({
      deny: ["eth_getTransactionReceipt", "debug_*"],
    });
  });

  it("rejects an empty method entry", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    methods:
      deny: [""]
`);
    expect(() => loadConfig(path)).toThrow();
  });
});
