import type { HealthConfig, ReorgConfig, SyncingConfig, TxpoolConfig, UpstreamConfig } from "./config.js";
import { reorgDepth, reorgsDetected } from "./metrics.js";
import { parseQuantity, type JsonRpcResponse } from "./rpc.js";
import { ReorgDetector, type ReorgEvent } from "./reorg.js";
import {
  Upstream,
  upstreamWsUrl,
  type UpstreamStatus,
} from "./upstream.js";
import { UpstreamWsConnection } from "./upstream-ws.js";
import WebSocket from "ws";

export interface PoolLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

export class UpstreamPool {
  private readonly upstreams: Upstream[];
  private readonly wsConns: Map<string, UpstreamWsConnection>;
  private timers: NodeJS.Timeout[] = [];
  /** Flat weighted selection list; each upstream appears `weight` times. */
  private selectionCursor = 0;
  /** Rolling window of chain-head progress samples for block-time estimation. */
  private headSamples: { elapsedMs: number; blocks: number }[] = [];
  private lastObservedHead: number | null = null;
  private lastObservedAt = 0;

  /** Listeners for locally observed heads (cache warming, local newHeads
   *  subscriptions and block filters). */
  private readonly headListeners = new Set<
    (head: Record<string, unknown>, upstreamName: string) => void
  >();
  /** Hash of the most recently announced head, for cross-upstream dedupe. */
  private lastAnnouncedHeadHash: string | null = null;

  /**
   * Reorg detector fed with every distinct announced head. Only present
   * when reorg detection is enabled and heads carry hash+parentHash (i.e.
   * health.wsHeads is on); plain HTTP polls see block numbers only.
   */
  private readonly reorgDetector: ReorgDetector | null;
  private readonly reorgListeners = new Set<(event: ReorgEvent) => void>();

  /**
   * Local pending-transaction mirror: hashes recently announced by upstreams
   * (deduped, bounded FIFO). Not a true txpool — mined/dropped transactions
   * are not evicted; it exists to fan out newPendingTransactions locally.
   */
  private readonly pendingTxSeen = new Set<string>();
  private readonly pendingTxListeners = new Set<(hash: string) => void>();
  private static readonly MAX_PENDING_TX = 4096;

  /**
   * Local syncing-status mirror. Each upstream's latest known status is
   * tracked (from its WS syncing feed when the mirror is on, and from the
   * HTTP health poll — which requests eth_syncing anyway — as fallback).
   * The announced status is the aggregate: if ANY upstream is syncing, the
   * pool reports syncing (that upstream's progress object); once none are,
   * it reports false. New subscribers are immediately answered with the
   * current aggregate, mirroring node behaviour; updates fan out only on
   * change.
   */
  private readonly syncingByUpstream = new Map<
    string,
    false | Record<string, unknown>
  >();
  private syncingStatus: false | Record<string, unknown> | null = null;
  private lastSyncingSerialized: string | null = null;
  private readonly syncingListeners = new Set<
    (status: false | Record<string, unknown>) => void
  >();

  /** True when the pool tracks heads via its own upstream newHeads subscriptions. */
  get localHeadsEnabled(): boolean {
    return this.health.wsHeads;
  }

  /** True when the local pending-transaction mirror is enabled. */
  get pendingTxMirrorEnabled(): boolean {
    return this.txpool.mirror;
  }

  /** True when the local syncing-status mirror is enabled. */
  get syncingMirrorEnabled(): boolean {
    return this.syncing.mirror;
  }

  /**
   * Register a listener fired for every distinct observed head (deduped by
   * block hash across upstreams). Returns an unsubscribe function.
   */
  onNewHead(
    listener: (head: Record<string, unknown>, upstreamName: string) => void,
  ): () => void {
    this.headListeners.add(listener);
    return () => {
      this.headListeners.delete(listener);
    };
  }

  /**
   * The canonical hash recorded at height `n` by the reorg detector, or
   * null when unknown (detector disabled, or the window does not cover the
   * height). Used by the response cache for read-time reorg validation.
   */
  canonicalHashAt(n: number): string | null {
    return this.reorgDetector?.canonicalHashAt(n) ?? null;
  }

  /**
   * Register a listener fired for every confirmed chain reorganization.
   * Returns an unsubscribe function.
   */
  onReorg(listener: (event: ReorgEvent) => void): () => void {
    this.reorgListeners.add(listener);
    return () => {
      this.reorgListeners.delete(listener);
    };
  }

  private announceReorg(event: ReorgEvent): void {
    reorgsDetected.inc();
    reorgDepth.observe(event.depth);
    this.logger?.warn(
      `chain reorg detected: heights ${event.fromNumber}..${event.toNumber} replaced ` +
        `(depth ${event.depth}${event.exact ? "" : "+"}), new head ${event.newHash}` +
        (event.oldHash !== null ? `, old head ${event.oldHash}` : ""),
    );
    for (const listener of this.reorgListeners) listener(event);
  }

  /**
   * Register a listener fired for every distinct pending transaction hash
   * observed from upstreams (deduped). Returns an unsubscribe function.
   */
  onPendingTx(listener: (hash: string) => void): () => void {
    this.pendingTxListeners.add(listener);
    return () => {
      this.pendingTxListeners.delete(listener);
    };
  }

  private announcePendingTx(hash: string): void {
    if (this.pendingTxSeen.has(hash)) return;
    this.pendingTxSeen.add(hash);
    if (this.pendingTxSeen.size > UpstreamPool.MAX_PENDING_TX) {
      const oldest = this.pendingTxSeen.values().next().value;
      if (oldest !== undefined) this.pendingTxSeen.delete(oldest);
    }
    for (const listener of this.pendingTxListeners) listener(hash);
  }

  /**
   * Register a listener for syncing-status changes (deduped). The listener
   * is immediately invoked with the latest known status, mirroring how a
   * node answers eth_subscribe("syncing"). Returns an unsubscribe function.
   */
  onSyncingStatus(
    listener: (status: false | Record<string, unknown>) => void,
  ): () => void {
    this.syncingListeners.add(listener);
    if (this.syncingStatus !== null) listener(this.syncingStatus);
    return () => {
      this.syncingListeners.delete(listener);
    };
  }

  /**
   * Record one upstream's latest syncing status and fan out the aggregate:
   * syncing (a progress object) while any upstream reports syncing, false
   * once none do. Fanned out only when the aggregate changes.
   */
  private updateSyncing(
    upstreamName: string,
    status: false | Record<string, unknown> | null,
  ): void {
    if (status === null) {
      this.syncingByUpstream.delete(upstreamName);
    } else {
      this.syncingByUpstream.set(upstreamName, status);
    }
    if (this.syncingByUpstream.size === 0) return; // nothing known yet
    let aggregate: false | Record<string, unknown> = false;
    for (const s of this.syncingByUpstream.values()) {
      if (s !== false) {
        aggregate = s;
        break;
      }
    }
    const serialized = JSON.stringify(aggregate);
    if (serialized === this.lastSyncingSerialized) return;
    this.lastSyncingSerialized = serialized;
    this.syncingStatus = aggregate;
    for (const listener of this.syncingListeners) listener(aggregate);
  }

  constructor(
    upstreamConfigs: UpstreamConfig[],
    private readonly health: HealthConfig,
    private readonly logger?: PoolLogger,
    private readonly expectedChainId?: number,
    private readonly txpool: TxpoolConfig = { mirror: false },
    private readonly syncing: SyncingConfig = { mirror: false },
    reorg: ReorgConfig = { enabled: true, windowSize: 128 },
  ) {
    this.upstreams = upstreamConfigs.map(
      (c) => new Upstream(c, health.requestTimeoutMs),
    );
    this.reorgDetector =
      reorg.enabled && health.wsHeads
        ? new ReorgDetector({ windowSize: reorg.windowSize })
        : null;
    // The persistent per-upstream WS connection exists when it carries at
    // least one feed (heads, the pending-tx mirror and/or the syncing
    // mirror). With all disabled, WS availability is detected by a
    // per-poll probe instead.
    this.wsConns = new Map(
      health.wsHeads || txpool.mirror || syncing.mirror
        ? this.upstreams.map((u) => [
            u.name,
            new UpstreamWsConnection(
              u,
              {
                newHeads: health.wsHeads,
                pendingTransactions: txpool.mirror,
                syncing: syncing.mirror,
              },
              {
                onHead: (head) => {
                  const blockNumber = parseQuantity(head.number);
                  if (blockNumber === null) return;
                  u.blockNumber = blockNumber;
                  const chainHead = this.chainHead;
                  if (chainHead !== null) this.observeHead(chainHead);
                  // Announce each distinct head once, however many
                  // upstreams push it; a reorg at the same height has a
                  // different hash and is announced again.
                  const hash = typeof head.hash === "string" ? head.hash : null;
                  if (hash !== null && hash === this.lastAnnouncedHeadHash) return;
                  if (hash !== null) this.lastAnnouncedHeadHash = hash;
                  // Reorg detection needs hash + parentHash; heads lacking
                  // either (defensive: non-standard upstreams) are skipped.
                  const parentHash =
                    typeof head.parentHash === "string" ? head.parentHash : null;
                  if (
                    this.reorgDetector !== null &&
                    hash !== null &&
                    parentHash !== null
                  ) {
                    for (const event of this.reorgDetector.observe(
                      { number: blockNumber, hash, parentHash },
                      u.name,
                    )) {
                      this.announceReorg(event);
                    }
                  }
                  for (const listener of this.headListeners) listener(head, u.name);
                },
                onPendingTx: (hash) => this.announcePendingTx(hash),
                onSyncing: (status) => this.updateSyncing(u.name, status),
                onAvailability: (available, detail) => {
                  if (u.wsHealthy !== available) {
                    if (available) {
                      this.logger?.info(
                        `upstream ${u.name} websocket is now available`,
                      );
                    } else {
                      this.logger?.warn(
                        `upstream ${u.name} websocket unavailable${detail !== undefined ? ` (${detail})` : ""}, falling back to HTTP polling`,
                      );
                    }
                  }
                  u.wsHealthy = available;
                },
              },
              Math.min(health.requestTimeoutMs, 5000),
              health.wsPingIntervalMs,
            ),
          ])
        : [],
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
    for (const conn of this.wsConns.values()) conn.stop();
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
      // Feed the mirror from the poll too: it is the fallback source while
      // an upstream's WS is down (eth_syncing is requested here anyway).
      if (
        syncingRes.result === false ||
        (typeof syncingRes.result === "object" && syncingRes.result !== null)
      ) {
        this.updateSyncing(
          u.name,
          syncingRes.result as false | Record<string, unknown>,
        );
      }
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
      // Drop the mirror entry: a node we can no longer reach must not pin
      // the aggregated syncing status to its last known value.
      this.updateSyncing(u.name, null);
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

    // Keep the persistent WS connection alive; heads (and the pending-tx
    // mirror) arrive over WS when available, otherwise the HTTP poll above
    // remains the source. With neither feed enabled, just probe WS
    // availability for client forwarding.
    const conn = this.wsConns.get(u.name);
    if (conn !== undefined) {
      await conn.ensureStarted();
    } else {
      await this.probeWs(u);
    }
  }

  /**
   * Probe the upstream's WebSocket endpoint: connect and make one
   * eth_chainId call. Only runs when the HTTP side is healthy; a node with
   * WS disabled keeps serving HTTP but is excluded from WS forwarding.
   * Used when wsHeads is disabled (no persistent subscription).
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

  /** Find an upstream by name, regardless of health (sticky filter routing). */
  byName(name: string): Upstream | undefined {
    return this.upstreams.find((u) => u.name === name);
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
