import type { HealthConfig, UpstreamConfig } from "./config.js";
import { parseQuantity, type JsonRpcResponse } from "./rpc.js";
import { Upstream, type UpstreamStatus } from "./upstream.js";

export interface PoolLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

export class UpstreamPool {
  private readonly upstreams: Upstream[];
  private timers: NodeJS.Timeout[] = [];
  /** Flat weighted selection list; each upstream appears `weight` times. */
  private selectionCursor = 0;

  constructor(
    upstreamConfigs: UpstreamConfig[],
    private readonly health: HealthConfig,
    private readonly logger?: PoolLogger,
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

  /** Poll one upstream: eth_syncing + eth_blockNumber in a single batch. */
  async poll(u: Upstream): Promise<void> {
    try {
      const body = await u.call([
        { jsonrpc: "2.0", id: 1, method: "eth_syncing", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]);
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

      u.consecutiveFailures = 0;
      if (!u.healthy) {
        u.healthy = true;
        this.logger?.info(`upstream ${u.name} is now healthy`);
      }
    } catch (err) {
      u.consecutiveFailures += 1;
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
    }
  }

  /** Healthy, not syncing, and within maxBlockLag of the pool head. */
  private eligible(): Upstream[] {
    const head = this.chainHead;
    return this.upstreams.filter((u) => {
      if (!u.healthy || u.syncing) return false;
      if (head === null || u.blockNumber === null) return false;
      return head - u.blockNumber <= this.health.maxBlockLag;
    });
  }

  hasEligible(): boolean {
    return this.eligible().length > 0;
  }

  /**
   * Weighted round-robin over eligible upstreams. Returns up to `count`
   * distinct upstreams in attempt order (for failover retries).
   */
  select(count = 1): Upstream[] {
    const candidates = this.eligible();
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

  status(): { chainHead: number | null; upstreams: UpstreamStatus[] } {
    return {
      chainHead: this.chainHead,
      upstreams: this.upstreams.map((u) => u.status()),
    };
  }
}
