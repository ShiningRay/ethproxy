import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { UpstreamPool } from "../src/pool.js";
import type { HealthConfig } from "../src/config.js";

const health: HealthConfig = {
  pollIntervalMs: 60000, // manual polling in tests
  requestTimeoutMs: 2000,
  maxBlockLag: 5,
  failureThreshold: 2,
  maxRetries: 2,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
};

interface MockNode {
  url: string;
  close: () => Promise<void>;
  set: (state: {
    syncing?: boolean;
    block?: number;
    fail?: boolean;
    chainId?: number;
  }) => void;
}

const servers: Server[] = [];

async function startMockNode(initial: {
  syncing?: boolean;
  block?: number;
  fail?: boolean;
  chainId?: number;
}): Promise<MockNode> {
  let state = { syncing: false, block: 100, fail: false, chainId: 1, ...initial };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (state.fail) {
        res.writeHead(500).end("boom");
        return;
      }
      // WS probes against the derived wsUrl hit this plain HTTP port with a
      // GET upgrade request (no body) — don't choke on it.
      let calls: { id: number; method: string }[];
      try {
        calls = JSON.parse(body) as { id: number; method: string }[];
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const list = Array.isArray(calls) ? calls : [calls];
      const replies = list.map((c) => {
        if (c.method === "eth_syncing") {
          return { jsonrpc: "2.0", id: c.id, result: state.syncing ? { startingBlock: "0x0" } : false };
        }
        if (c.method === "eth_blockNumber") {
          return { jsonrpc: "2.0", id: c.id, result: `0x${state.block.toString(16)}` };
        }
        if (c.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: c.id, result: `0x${state.chainId.toString(16)}` };
        }
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "not found" } };
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(calls) ? replies : replies[0]));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    set: (s) => {
      state = { ...state, ...s };
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("UpstreamPool", () => {
  it("marks responsive nodes healthy and selects them", async () => {
    const node = await startMockNode({});
    const pool = new UpstreamPool([{ name: "a", url: node.url, weight: 1 }], health);
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(true);
    expect(pool.chainHead).toBe(100);
    expect(pool.select(1)[0]?.name).toBe("a");
  });

  it("excludes nodes that are still syncing", async () => {
    const node = await startMockNode({ syncing: true });
    const pool = new UpstreamPool([{ name: "a", url: node.url, weight: 1 }], health);
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(false);
    expect(pool.status().upstreams[0]?.syncing).toBe(true);
  });

  it("excludes nodes lagging behind the pool head", async () => {
    const ahead = await startMockNode({ block: 1000 });
    const behind = await startMockNode({ block: 980 }); // lag 20 > maxBlockLag 5
    const pool = new UpstreamPool(
      [
        { name: "ahead", url: ahead.url, weight: 1 },
        { name: "behind", url: behind.url, weight: 1 },
      ],
      health,
    );
    await pool.pollAll();
    expect(pool.chainHead).toBe(1000);
    expect(pool.select(10).map((u) => u.name)).toEqual(["ahead"]);

    // it recovers automatically once caught up
    behind.set({ block: 1000 });
    await pool.pollAll();
    expect(new Set(pool.select(10).map((u) => u.name))).toEqual(
      new Set(["ahead", "behind"]),
    );
  });

  it("marks failing nodes unhealthy after the threshold and recovers them", async () => {
    const node = await startMockNode({});
    const pool = new UpstreamPool([{ name: "a", url: node.url, weight: 1 }], health);
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(true);

    node.set({ fail: true });
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(true); // 1 failure < threshold 2
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(false);

    node.set({ fail: false });
    await pool.pollAll();
    expect(pool.hasEligible()).toBe(true);
  });

  it("weights selection round-robin by node weight", async () => {
    const a = await startMockNode({});
    const b = await startMockNode({});
    const pool = new UpstreamPool(
      [
        { name: "a", url: a.url, weight: 2 },
        { name: "b", url: b.url, weight: 1 },
      ],
      health,
    );
    await pool.pollAll();
    const counts = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const pick = pool.select(1)[0]!;
      counts.set(pick.name, (counts.get(pick.name) ?? 0) + 1);
    }
    expect(counts.get("a")).toBe(20);
    expect(counts.get("b")).toBe(10);
  });

  it("excludes nodes on a different chain than the configured chainId", async () => {
    const mainnet = await startMockNode({ chainId: 1 });
    const bsc = await startMockNode({ chainId: 56 });
    const pool = new UpstreamPool(
      [
        { name: "mainnet", url: mainnet.url, weight: 1 },
        { name: "bsc", url: bsc.url, weight: 1 },
      ],
      health,
      undefined,
      1, // expected chainId
    );
    await pool.pollAll();
    expect(pool.chainId).toBe(1);
    expect(pool.select(10).map((u) => u.name)).toEqual(["mainnet"]);
  });

  it("adopts the majority chainId when none is configured", async () => {
    const a = await startMockNode({ chainId: 1 });
    const b = await startMockNode({ chainId: 1 });
    const rogue = await startMockNode({ chainId: 56 });
    const pool = new UpstreamPool(
      [
        { name: "a", url: a.url, weight: 1 },
        { name: "b", url: b.url, weight: 1 },
        { name: "rogue", url: rogue.url, weight: 1 },
      ],
      health,
    );
    await pool.pollAll();
    expect(pool.chainId).toBe(1);
    expect(new Set(pool.select(10).map((u) => u.name))).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("exposes per-node chainId in status", async () => {
    const node = await startMockNode({ chainId: 1 });
    const pool = new UpstreamPool([{ name: "a", url: node.url, weight: 1 }], health);
    await pool.pollAll();
    expect(pool.status().chainId).toBe(1);
    expect(pool.status().upstreams[0]?.chainId).toBe(1);
  });

  it("probes websocket endpoints and selects WS-healthy nodes for forwarding", async () => {
    const http = await startMockNode({});

    // No wsUrl configured: derived from the HTTP url, which is a plain HTTP
    // port — the probe fails fast and the node is excluded from selectWs.
    const noWs = new UpstreamPool([{ name: "a", url: http.url, weight: 1 }], health);
    await noWs.pollAll();
    expect(noWs.status().upstreams[0]?.wsHealthy).toBe(false);
    expect(noWs.selectWs(1)).toEqual([]);

    // With a working wsUrl the node becomes WS-healthy and selectable.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.on("listening", r));
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const req = JSON.parse(data.toString()) as { id: number };
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0x1" }));
      });
    });
    const wsPort = (wss.address() as AddressInfo).port;

    const withWs = new UpstreamPool(
      [{ name: "b", url: http.url, wsUrl: `ws://127.0.0.1:${wsPort}`, weight: 1 }],
      health,
    );
    await withWs.pollAll();
    expect(withWs.status().upstreams[0]?.wsHealthy).toBe(true);
    expect(withWs.selectWs(1).map((u) => u.name)).toEqual(["b"]);

    // WS endpoint dies -> next poll marks it down again.
    await new Promise<void>((r) => wss.close(() => r()));
    await withWs.pollAll();
    expect(withWs.status().upstreams[0]?.wsHealthy).toBe(false);
  });
});
