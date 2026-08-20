import type { HealthConfig, UpstreamConfig } from "./config.js";
import { parseQuantity, type JsonRpcResponse } from "./rpc.js";
import {
  Upstream,
  upstreamWsUrl,
  type UpstreamStatus,
} from "./upstream.js";
import WebSocket from "ws";

export interface PoolLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

export class UpstreamPool {
  private readonly upstreams: Upstream[];
  private timers: NodeJS.Timeout[] = [];
  /** Flat weighted selection list; each upstream appears `weight` times. */
  private selectionCursor = 0;
  /** Rolling window of chain-head progress samples for block-time estimation. */
  private headSamples: { elapsedMs: number; blocks: number }[] = [];
  private lastObservedHead: number | null = null;
  private lastObservedAt = 0;

  constructor(
    upstreamConfigs: UpstreamConfig[],
    private readonly health: HealthConfig,
    private readonly logger?: PoolLogger,
    private readonly expectedChainId?: number,
  ) {
    this.upstreams = upstreamConfigs.map(
      (c) => new Upstream(c, health.requestTimeoutMs),
    );
  }

  /** Highest block number known across the pool; null before first poll. */
  get chainHead(): number | null {
    let max: number | null = null;
    for (const u of this.upstreams) {
      if (u.blockNumber !== null && (max === null || u.blockNumber > max)) {
        max = u.blockNumber;
      }
    }
    return max;
  }

  /**
   * The pool's reference chain id: the configured one when set, otherwise
   * the majority chain id among upstreams that have reported one.
   * Null when no upstream has reported a chain id yet.
   */
  get chainId(): number | null {
    if (this.expectedChainId !== undefined) return this.expectedChainId;
    const counts = new Map<number, number>();
    for (const u of this.upstreams) {
      if (u.chainId !== null) {
        counts.set(u.chainId, (counts.get(u.chainId) ?? 0) + 1);
      }
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Record a chain-head observation. Called after every successful poll;
   * exposed publicly so tests can drive it with synthetic values.
   */
  observeHead(head: number, now = Date.now()): void {
    if (this.lastObservedHead !== null && head > this.lastObservedHead) {
      this.headSamples.push({
        elapsedMs: now - this.lastObservedAt,
        blocks: head - this.lastObservedHead,
      });
      if (this.headSamples.length > 16) this.headSamples.shift();
    }
    if (head !== this.lastObservedHead) {
      this.lastObservedHead = head;
      this.lastObservedAt = now;
    }
  }

  /**
   * Rolling average time per block across recent head progress, or null
   * when no progress has been observed yet.
   */
  get estimatedBlockIntervalMs(): number | null {
    let elapsed = 0;
    let blocks = 0;
    for (const s of this.headSamples) {
      elapsed += s.elapsedMs;
      blocks += s.blocks;
    }
    return blocks === 0 ? null : elapsed / blocks;
  }

  start(): void {
    void this.pollAll();
    for (const u of this.upstreams) {
      const timer = setInterval(
        () => void this.poll(u),
        this.health.pollIntervalMs,
      );
      timer.unref();
      this.timers.push(timer);
    }
  }

  /** Poll every upstream once; awaits all. Useful at startup and in tests. */
  async pollAll(): Promise<void> {
    await Promise.all(this.upstreams.map((u) => this.poll(u)));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Poll one upstream: eth_syncing + eth_blockNumber + eth_chainId in one batch. */
  async poll(u: Upstream): Promise<void> {
    try {
      const startedAt = Date.now();
      const body = await u.call([
        { jsonrpc: "2.0", id: 1, method: "eth_syncing", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
      ]);
      u.recordLatency(Date.now() - startedAt);
      const responses = Array.isArray(body) ? body : [body];
      const byId = new Map<number, JsonRpcResponse>();
      for (const r of responses) {
        if (typeof r.id === "number") byId.set(r.id, r);
      }
      const syncingRes = byId.get(1);
      const blockRes = byId.get(2);
      if (!syncingRes || !blockRes || syncingRes.error || blockRes.error) {
        throw new Error("unexpected poll response");
      }
      u.syncing = syncingRes.result !== false;
      u.blockNumber = parseQuantity(blockRes.result);
      if (u.blockNumber === null) throw new Error("bad eth_blockNumber");

      // eth_chainId is optional: an old node not supporting it must not fail
      // the whole poll, but will be excluded while a reference chain is known.
      const chainRes = byId.get(3);
      const reportedChainId =
        chainRes && !chainRes.error ? parseQuantity(chainRes.result) : null;
      if (reportedChainId !== null && reportedChainId !== u.chainId) {
        const reference = this.chainId;
        if (reference !== null && reportedChainId !== reference) {
          this.logger?.warn(
            `upstream ${u.name} reports chainId ${reportedChainId}, expected ${reference} — it will be excluded`,
          );
        }
      }
      u.chainId = reportedChainId;

      u.consecutiveFailures = 0;
      if (!u.healthy) {
        u.healthy = true;
        this.logger?.info(`upstream ${u.name} is now healthy`);
      }
      const head = this.chainHead;
      if (head !== null) this.observeHead(head);
    } catch (err) {
      u.consecutiveFailures += 1;
      u.wsHealthy = false;
      if (
        u.healthy &&
        u.consecutiveFailures >= this.health.failureThreshold
      ) {
        u.healthy = false;
        this.logger?.warn(
          `upstream ${u.name} marked unhealthy after ${u.consecutiveFailures} failures`,
        );
      }
      if (!u.healthy) {
        this.logger?.warn(`poll of ${u.name} failed`, err);
      }
      return;
    }

    await this.probeWs(u);
  }

  /**
   * Probe the upstream's WebSocket endpoint: connect and make one
   * eth_chainId call. Only runs when the HTTP side is healthy; a node with
   * WS disabled keeps serving HTTP but is excluded from WS forwarding.
   */
  private async probeWs(u: Upstream): Promise<void> {
    const url = upstreamWsUrl(u);
    const timeoutMs = Math.min(this.health.requestTimeoutMs, 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("ws probe timeout"));
        }, timeoutMs);
        const done = (err?: Error) => {
          clearTimeout(timer);
          ws.close();
          err ? reject(err) : resolve();
        };
        ws.on("open", () => {
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          );
        });
        ws.on("message", () => done());
        ws.on("error", (err) => done(err));
      });
      if (u.wsHealthy !== true) {
        this.logger?.info(`upstream ${u.name} websocket is now available`);
      }
      u.wsHealthy = true;
    } catch (err) {
      if (u.wsHealthy !== false) {
        this.logger?.warn(`upstream ${u.name} websocket probe failed`, err);
      }
      u.wsHealthy = false;
    }
  }

  /** Healthy, on the reference chain, not syncing, within maxBlockLag of the pool head. */
  private eligible(): Upstream[] {
    const head = this.chainHead;
    const chainId = this.chainId;
    return this.upstreams.filter((u) => {
      if (!u.healthy || u.syncing) return false;
      if (head === null || u.blockNumber === null) return false;
      if (chainId !== null && u.chainId !== chainId) return false;
      return head - u.blockNumber <= this.health.maxBlockLag;
    });
  }

  hasEligible(): boolean {
    return this.eligible().length > 0;
  }

  /**
   * Weighted round-robin over eligible upstreams. Returns up to `count`
   * distinct upstreams in attempt order (for failover retries).
   * When minBlock is set, only upstreams that have that block are picked.
   */
  select(count = 1, minBlock?: number): Upstream[] {
    let candidates = this.eligible();
    if (minBlock !== undefined) {
      candidates = candidates.filter(
        (u) => u.blockNumber !== null && u.blockNumber >= minBlock,
      );
    }
    return this.pick(candidates, count);
  }

  /**
   * Like select(), but restricted to upstreams whose WebSocket endpoint
   * responded to the latest probe. Used for WS forwarding.
   */
  selectWs(count = 1): Upstream[] {
    return this.pick(
      this.eligible().filter((u) => u.wsHealthy === true),
      count,
    );
  }

  private pick(candidates: Upstream[], count: number): Upstream[] {
    if (candidates.length === 0) return [];
    const weighted = candidates.flatMap((u) =>
      Array<Upstream>(u.config.weight).fill(u),
    );
    const picks: Upstream[] = [];
    const seen = new Set<string>();
    const limit = Math.min(count, candidates.length);
    for (let i = 0; i < weighted.length && picks.length < limit; i++) {
      const u = weighted[(this.selectionCursor + i) % weighted.length]!;
      if (seen.has(u.name)) continue;
      seen.add(u.name);
      picks.push(u);
    }
    this.selectionCursor = (this.selectionCursor + 1) % weighted.length;
    return picks;
  }

  status(): {
    chainHead: number | null;
    chainId: number | null;
    estimatedBlockIntervalMs: number | null;
    upstreams: UpstreamStatus[];
  } {
    return {
      chainHead: this.chainHead,
      chainId: this.chainId,
      estimatedBlockIntervalMs: this.estimatedBlockIntervalMs,
      upstreams: this.upstreams.map((u) => u.status()),
    };
  }
}
