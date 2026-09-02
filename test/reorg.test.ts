import { describe, expect, it } from "vitest";
import { ReorgDetector, type ObservedHead } from "../src/reorg.js";

const h = (n: number, tag = ""): string => `0x${tag}h${n}`;

/** Canonical-chain head at height n. */
function head(n: number): ObservedHead {
  return { number: n, hash: h(n), parentHash: h(n - 1) };
}

/**
 * Head on a fork that diverges at height `forkAt`: heights below the fork
 * share the canonical parents, heights from forkAt on carry tagged hashes.
 */
function forkHead(n: number, forkAt: number, tag = "x"): ObservedHead {
  return {
    number: n,
    hash: h(n, tag),
    parentHash: n - 1 < forkAt ? h(n - 1) : h(n - 1, tag),
  };
}

/** Feed a linear chain 1..n into the detector. */
function seedChain(d: ReorgDetector, upTo: number, upstream = "a"): void {
  for (let n = 1; n <= upTo; n++) {
    expect(d.observe(head(n), upstream)).toEqual([]);
  }
}

describe("ReorgDetector", () => {
  it("a linear chain produces no events", () => {
    const d = new ReorgDetector();
    seedChain(d, 20);
  });

  it("consistent re-announcements of known heads produce no events", () => {
    const d = new ReorgDetector();
    seedChain(d, 5);
    expect(d.observe(head(5), "b")).toEqual([]); // same head, other upstream
    expect(d.observe(head(3), "a")).toEqual([]); // late duplicate
    expect(d.observe(head(5), "a")).toEqual([]);
  });

  it("confirms a 1-deep reorg when a child builds on the conflicting head", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);

    // Conflicting head at the tip height: candidate only, no event yet.
    expect(d.observe(forkHead(10, 10), "a")).toEqual([]);
    // The chain adopts the fork: the next head builds on it.
    const events = d.observe(forkHead(11, 10), "a");
    expect(events).toEqual([
      {
        fromNumber: 10,
        toNumber: 10,
        depth: 1,
        exact: true,
        newHash: h(10, "x"),
        oldHash: h(10),
      },
    ]);
    // The fork is now canonical: the chain continues without further events.
    expect(d.observe(forkHead(12, 10), "a")).toEqual([]);
  });

  it("confirms a candidate announced by two distinct upstreams", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);
    expect(d.observe(forkHead(10, 10), "a")).toEqual([]);
    // The same upstream repeating itself does not reach the quorum.
    expect(d.observe(forkHead(10, 10), "a")).toEqual([]);
    const events = d.observe(forkHead(10, 10), "b");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      depth: 1,
      exact: true,
      newHash: h(10, "x"),
      oldHash: h(10),
    });
  });

  it("confirms when only the fork's successor is ever seen", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);
    // The fork's tip (10x) is never announced; its successor 11x arrives
    // claiming a parent that differs from our record at height 10.
    expect(d.observe(forkHead(11, 10), "a")).toEqual([]); // structural candidate
    const events = d.observe(forkHead(12, 10), "a"); // child confirms it
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromNumber: 10, // provably replaced: 11x's parent != our 10
      toNumber: 10,
      depth: 1,
      exact: false, // the fork point itself was never observed
      newHash: h(11, "x"),
      oldHash: h(10),
    });
  });

  it("reports exact depth when the fork blocks themselves are announced", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);

    // A 3-deep reorg announced block by block (as nodes do when the
    // canonical chain switches): 8x diverges from canonical 7.
    expect(d.observe(forkHead(8, 8), "a")).toEqual([]); // candidate at height 8
    const events = d.observe(forkHead(9, 8), "a"); // builds on the candidate
    expect(events).toEqual([
      {
        fromNumber: 8,
        toNumber: 10,
        depth: 3,
        exact: true,
        newHash: h(8, "x"),
        oldHash: h(8),
      },
    ]);
    // The rest of the fork extends the new canonical chain silently.
    expect(d.observe(forkHead(10, 8), "a")).toEqual([]);
    expect(d.observe(forkHead(11, 8), "a")).toEqual([]);
  });

  it("reports a lower bound when the fork point is beyond the window", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);
    // Only the fork's tip is seen; its parent (9x) was never announced, so
    // the exact fork point (8) cannot be located — but height 9 is provably
    // replaced since 10x's parent differs from our 9.
    expect(d.observe(forkHead(10, 8), "a")).toEqual([]);
    const events = d.observe(forkHead(11, 8), "a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromNumber: 9,
      toNumber: 10,
      depth: 2, // lower bound; the true depth is 3
      exact: false,
      newHash: h(10, "x"),
    });
  });

  it("ignores a conflicting head that is never adopted (upstream noise)", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);
    expect(d.observe(forkHead(10, 10), "a")).toEqual([]); // stray conflicting head
    // The chain keeps building on the original branch: no event, ever.
    expect(d.observe(head(11), "a")).toEqual([]);
    expect(d.observe(head(12), "b")).toEqual([]);
  });

  it("expires unconfirmed candidates after the TTL", () => {
    let now = 1000;
    const d = new ReorgDetector({ candidateTtlMs: 60_000, now: () => now });
    seedChain(d, 10);
    expect(d.observe(forkHead(10, 10), "a")).toEqual([]);
    now += 61_000; // candidate expired
    // A late echo of the dead fork from a second upstream confirms nothing
    // (before expiry it would have reached the quorum).
    expect(d.observe(forkHead(10, 10), "b")).toEqual([]);
    // The canonical chain advancing past the fork emits no event.
    expect(d.observe(head(11), "a")).toEqual([]);
    expect(d.observe(head(12), "b")).toEqual([]);
  });

  it("missed heads (gap) reseed silently without a reorg event", () => {
    const d = new ReorgDetector();
    seedChain(d, 5);
    expect(d.observe(head(20), "a")).toEqual([]); // jumped ahead
    expect(d.observe(head(21), "a")).toEqual([]); // continues normally
  });

  it("a stale old-fork head after a confirmed reorg does not retrigger", () => {
    const d = new ReorgDetector();
    seedChain(d, 10);
    d.observe(forkHead(10, 10), "a");
    expect(d.observe(forkHead(11, 10), "a")).toHaveLength(1); // reorg confirmed
    // A lagging upstream still announces the old branch's tip: candidate...
    expect(d.observe(head(10), "b")).toEqual([]);
    // ...which dies unconfirmed as the new chain advances.
    expect(d.observe(forkHead(12, 10), "a")).toEqual([]);
  });

  it("ignores conflicting heads at heights evicted from the window", () => {
    const d = new ReorgDetector({ windowSize: 16 });
    seedChain(d, 100);
    // Heights 1..84 are evicted: conflicts there match nothing and cannot
    // even become candidates.
    expect(d.observe(forkHead(1, 1), "a")).toEqual([]);
    expect(d.observe(forkHead(2, 1), "a")).toEqual([]);
    // The live tip still works.
    expect(d.observe(forkHead(100, 100), "a")).toEqual([]);
    const events = d.observe(forkHead(101, 100), "a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ depth: 1, exact: true });
  });
});

// ---------------------------------------------------------------------------
// Pool-level integration: heads pushed through a mock upstream WS feed.
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { HealthConfig } from "../src/config.js";
import { UpstreamPool } from "../src/pool.js";
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
  wsPingIntervalMs: 30000,
};

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startHttpMock(initialBlock: number) {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: { id: number; method: string }[];
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies = list.map((call) => {
        if (call.method === "eth_syncing") {
          return { jsonrpc: "2.0", id: call.id, result: false };
        }
        if (call.method === "eth_blockNumber") {
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: `0x${initialBlock.toString(16)}`,
          };
        }
        if (call.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: call.id, result: "0x1" };
        }
        return {
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32601, message: "no" },
        };
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
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
          result: {
            number: `0x${n.toString(16)}`,
            hash,
            parentHash,
          },
        },
      });
      for (const ws of sockets) ws.send(msg);
    },
  };
}

async function startPool(reorg?: { enabled: boolean; windowSize: number }) {
  const http = await startHttpMock(1000);
  const ws = await startWsMock();
  const pool = new UpstreamPool(
    [{ name: "a", url: http.url, wsUrl: ws.url, weight: 1 }],
    health,
    undefined,
    undefined,
    undefined,
    undefined,
    reorg,
  );
  cleanups.push(async () => pool.stop());
  const events: ReorgEvent[] = [];
  pool.onReorg((e) => events.push(e));
  await pool.pollAll();
  await waitFor(() => ws.socketCount() === 1);
  return { pool, ws, events };
}

describe("pool reorg detection over newHeads", () => {
  it("emits one event when the announced chain reorgs the tip", async () => {
    const { ws, events } = await startPool();

    ws.pushHead(1001, "0xa1001", "0xp1000");
    ws.pushHead(1002, "0xa1002", "0xa1001");
    await waitFor(() => ws.socketCount() === 1);

    // Reorg at the tip: 1002 is replaced, then the fork extends.
    ws.pushHead(1002, "0xb1002", "0xa1001");
    ws.pushHead(1003, "0xb1003", "0xb1002");
    await waitFor(() => events.length === 1);

    expect(events[0]).toMatchObject({
      fromNumber: 1002,
      toNumber: 1002,
      depth: 1,
      exact: true,
      newHash: "0xb1002",
      oldHash: "0xa1002",
    });

    // The new branch keeps extending: no further events.
    ws.pushHead(1004, "0xb1004", "0xb1003");
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1);
  });

  it("a stray conflicting head that dies out emits nothing", async () => {
    const { ws, events } = await startPool();
    ws.pushHead(1001, "0xa1001", "0xp1000");
    ws.pushHead(1002, "0xa1002", "0xa1001");
    ws.pushHead(1002, "0xb1002", "0xa1001"); // never adopted
    ws.pushHead(1003, "0xa1003", "0xa1002"); // original branch continues
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);
  });

  it("does not detect anything when reorg detection is disabled", async () => {
    const { ws, events } = await startPool({ enabled: false, windowSize: 128 });
    ws.pushHead(1001, "0xa1001", "0xp1000");
    ws.pushHead(1002, "0xa1002", "0xa1001");
    ws.pushHead(1002, "0xb1002", "0xa1001");
    ws.pushHead(1003, "0xb1003", "0xb1002");
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);
  });
});
