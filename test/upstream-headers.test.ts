import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadConfig, type HealthConfig } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
import { Upstream } from "../src/upstream.js";

const health: HealthConfig = {
  pollIntervalMs: 60000,
  requestTimeoutMs: 2000,
  maxBlockLag: 5,
  failureThreshold: 2,
  maxRetries: 2,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
  wsHeads: true,
  wsPingIntervalMs: 30000,
};

const servers: Server[] = [];
const pools: UpstreamPool[] = [];

afterEach(async () => {
  for (const p of pools.splice(0)) p.stop();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

type SeenHeaders = Record<string, string | string[] | undefined>;

async function startHttpMock(): Promise<{ url: string; seen: SeenHeaders[] }> {
  const seen: SeenHeaders[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    seen.push(req.headers);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const out = list.map((c: { id: number; method: string }) => {
        if (c.method === "eth_syncing") {
          return { jsonrpc: "2.0", id: c.id, result: false };
        }
        if (c.method === "eth_blockNumber") {
          return { jsonrpc: "2.0", id: c.id, result: "0x64" };
        }
        if (c.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: c.id, result: "0x1" };
        }
        return { jsonrpc: "2.0", id: c.id, result: null };
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

/** WS server that captures handshake headers and echoes subscription acks. */
async function startWsMock(): Promise<{
  wsUrl: string;
  upgradeHeaders: SeenHeaders[];
  close: () => Promise<void>;
}> {
  const upgradeHeaders: SeenHeaders[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", (ws, req) => {
    upgradeHeaders.push(req.headers);
    ws.on("message", (data) => {
      const req2 = JSON.parse(data.toString()) as { id: number };
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: "0xsub1" }),
      );
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    upgradeHeaders,
    close: () =>
      new Promise<void>((r) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => r());
      }),
  };
}

describe("upstream headers: JSON-RPC calls", () => {
  it("sends configured headers with every request", async () => {
    const mock = await startHttpMock();
    const u = new Upstream(
      {
        name: "a",
        url: mock.url,
        weight: 1,
        headers: { "x-api-key": "s3cret", "x-extra": "1" },
      },
      2000,
    );
    await u.call({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    const h = mock.seen[0]!;
    expect(h["x-api-key"]).toBe("s3cret");
    expect(h["x-extra"]).toBe("1");
    expect(h["content-type"]).toBe("application/json");
  });

  it("lets configured headers override the default content type", async () => {
    const mock = await startHttpMock();
    const u = new Upstream(
      {
        name: "a",
        url: mock.url,
        weight: 1,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
      2000,
    );
    await u.call({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    expect(mock.seen[0]!["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
  });
});

describe("upstream headers: WebSocket handshakes", () => {
  it("sends configured headers on the persistent newHeads connection", async () => {
    const http = await startHttpMock();
    const wss = await startWsMock();
    const pool = new UpstreamPool(
      [
        {
          name: "b",
          url: http.url,
          wsUrl: wss.wsUrl,
          weight: 1,
          headers: { authorization: "Bearer tok" },
        },
      ],
      health,
    );
    pools.push(pool);
    await pool.pollAll();
    await waitFor(() => pool.status().upstreams[0]?.wsHealthy === true);
    expect(wss.upgradeHeaders[0]?.["authorization"]).toBe("Bearer tok");
    await wss.close();
  });

  it("sends configured headers on per-poll WS probes (wsHeads off)", async () => {
    const http = await startHttpMock();
    const wss = await startWsMock();
    const pool = new UpstreamPool(
      [
        {
          name: "c",
          url: http.url,
          wsUrl: wss.wsUrl,
          weight: 1,
          headers: { "x-probe": "1" },
        },
      ],
      { ...health, wsHeads: false },
    );
    pools.push(pool);
    await pool.pollAll();
    await waitFor(() => pool.status().upstreams[0]?.wsHealthy === true);
    expect(wss.upgradeHeaders[0]?.["x-probe"]).toBe("1");
    await wss.close();
  });
});

describe("upstream headers: config parsing", () => {
  function writeConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ethproxy-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, body);
    return path;
  }

  it("parses a headers map", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    headers:
      x-api-key: k-123
      x-network: bsc
`);
    const config = loadConfig(path);
    expect(config.upstreams[0]!.headers).toEqual({
      "x-api-key": "k-123",
      "x-network": "bsc",
    });
  });

  it("rejects non-string header values", () => {
    const path = writeConfig(`
upstreams:
  - name: a
    url: http://127.0.0.1:8545
    headers:
      x-api-key: 123
`);
    expect(() => loadConfig(path)).toThrow();
  });
});
