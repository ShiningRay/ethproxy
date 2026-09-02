import {
  cacheKey,
  parseValidatedEntry,
  rawCacheKey,
  ResponseCache,
  wrapValidatedEntry,
  type CacheStats,
} from "./cache/index.js";
import {
  normalizeRawKeyParams,
  RAW_KEY_METHODS,
  requestPolicy,
  responseTtl,
  type CacheRuleContext,
  type RequestPolicy,
} from "./cache-rules.js";
import type { Config } from "./config.js";
import {
  FILTER_CREATE_METHODS,
  FILTER_POLL_METHODS,
  FILTER_UNINSTALL_METHOD,
  isFilterMethod,
  StickyFilterRouter,
} from "./filters.js";
import type { UpstreamPool } from "./pool.js";
import {
  errorResponse,
  formatRequestForLog,
  isJsonRpcRequest,
  parseQuantity,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./rpc.js";
import { isMethodBlocked, logsRangeViolation } from "./security.js";
import { rpcDuration, rpcRequests, upstreamRequests } from "./metrics.js";
import { translateLatest } from "./translate.js";
import { Upstream, UpstreamTransportError } from "./upstream.js";
import { randomBytes } from "node:crypto";

export interface ProxyLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

type CacheOutcome = "hit" | "miss" | "local" | "error";

interface RequestMetrics {
  upstreamMs: number;
  cacheSummary: string;
  upstreamNames: Set<string>;
}

function formatCacheSummary(outcomes: CacheOutcome[]): string {
  const counts = { hit: 0, miss: 0, local: 0, error: 0 };
  for (const o of outcomes) counts[o] += 1;
  const parts: string[] = [];
  if (counts.hit) parts.push(`hit=${counts.hit}`);
  if (counts.miss) parts.push(`miss=${counts.miss}`);
  if (counts.local) parts.push(`local=${counts.local}`);
  if (counts.error) parts.push(`error=${counts.error}`);
  return parts.join(",") || "error";
}

/** Methods with side effects: never retried against a second upstream. */
const NO_RETRY_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
]);

/**
 * Effective short TTL for head-dependent data. With dynamicTtl enabled and
 * a block-time estimate available, use blockInterval / 4 clamped to
 * [minTtlMs, shortTtlMs]; otherwise fall back to the configured shortTtlMs.
 */
export function computeShortTtlMs(
  estimatedBlockIntervalMs: number | null,
  cfg: { dynamicTtl: boolean; minTtlMs: number; shortTtlMs: number },
): number {
  if (!cfg.dynamicTtl || estimatedBlockIntervalMs === null) {
    return cfg.shortTtlMs;
  }
  return Math.min(
    cfg.shortTtlMs,
    Math.max(cfg.minTtlMs, Math.round(estimatedBlockIntervalMs / 4)),
  );
}

/**
 * Delay before retry attempt `attempt` (1-based: 1 = first retry).
 * Exponential backoff: base * 2^(attempt-1), capped at max.
 */
export function retryDelayMs(
  attempt: number,
  cfg: { retryBaseDelayMs: number; retryMaxDelayMs: number },
): number {
  return Math.min(
    cfg.retryMaxDelayMs,
    cfg.retryBaseDelayMs * 2 ** (attempt - 1),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProxyHandler {
  /**
   * In-flight upstream fetches keyed by cache key (single-flight): concurrent
   * misses for the same key share one upstream request instead of stampeding.
   */
  private readonly inflight = new Map<
    string,
    Promise<{ response: JsonRpcResponse; upstreamMs: number; upstreamName?: string }>
  >();

  /**
   * Head hashes already warmed into the cache, so duplicate newHeads
   * announcements from several upstreams cause at most one fetch.
   */
  private readonly warmedHeads = new Set<string>();

  /**
   * Rolling buffer of recently observed heads (ascending arrival order),
   * backing locally served eth_newBlockFilter instances.
   */
  private readonly recentHeads: { number: number; hash: string }[] = [];
  private static readonly MAX_RECENT_HEADS = 2048;

  /** Locally served block filters: proxyId -> cursor + idle expiry. */
  private readonly localBlockFilters = new Map<
    string,
    { cursor: number; expiresAt: number }
  >();

  /**
   * Responses answered from local data without any upstream call, excluding
   * cache hits (counted by ResponseCache): eth_blockNumber from the pool
   * head and locally served block-filter calls.
   */
  private readonly localAnswers = { blockNumber: 0, filters: 0 };

  /**
   * Aggregate of responses served entirely from local data: cache hits plus
   * direct local answers, with the non-cache breakdown.
   */
  localStats(): {
    total: number;
    cacheHits: number;
    blockNumber: number;
    filters: number;
  } {
    const cacheHits = this.cache.stats().hits;
    return {
      total: cacheHits + this.localAnswers.blockNumber + this.localAnswers.filters,
      cacheHits,
      blockNumber: this.localAnswers.blockNumber,
      filters: this.localAnswers.filters,
    };
  }

  constructor(
    private readonly pool: UpstreamPool,
    private readonly cache: ResponseCache,
    private readonly config: Config,
    private readonly filters: StickyFilterRouter = new StickyFilterRouter(
      config.filters.stickyTtlMs,
    ),
    private readonly logger?: ProxyLogger,
  ) {
    pool.onNewHead((head, upstreamName) => {
      this.recordHead(head);
      void this.warmBlockFromHead(upstreamName, head);
    });
  }

  /** Append an observed head to the rolling buffer (pool already deduped). */
  private recordHead(head: Record<string, unknown>): void {
    const n = parseQuantity(head.number);
    const hash = typeof head.hash === "string" ? head.hash : null;
    if (n === null || hash === null) return;
    this.recentHeads.push({ number: n, hash });
    if (this.recentHeads.length > ProxyHandler.MAX_RECENT_HEADS) {
      this.recentHeads.splice(0, this.recentHeads.length - ProxyHandler.MAX_RECENT_HEADS);
    }
  }

  async handle(
    body: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    const startedAt = performance.now();
    const metrics: RequestMetrics = {
      upstreamMs: 0,
      cacheSummary: "error",
      upstreamNames: new Set(),
    };
    const method = Array.isArray(body)
      ? "batch"
      : isJsonRpcRequest(body)
        ? body.method
        : "invalid";
    const record = (result: "ok" | "error"): void => {
      rpcRequests.inc({ method, result });
      rpcDuration.observe({ method }, (performance.now() - startedAt) / 1000);
    };
    const log = (): void => {
      const totalMs = Math.round(performance.now() - startedAt);
      const upstreamMs = Math.round(metrics.upstreamMs);
      const upstreams =
        metrics.upstreamNames.size > 0
          ? [...metrics.upstreamNames].join(",")
          : "none";
      this.logger?.info(
        `request: ${formatRequestForLog(body)} | cache=${metrics.cacheSummary} | upstream=${upstreams} | upstreamMs=${upstreamMs} | totalMs=${totalMs}`,
      );
    };

    if (Array.isArray(body)) {
      if (body.length === 0) {
        record("error");
        log();
        return errorResponse(null, -32600, "Invalid Request: empty batch");
      }
      if (body.length > this.config.security.maxBatchSize) {
        record("error");
        log();
        return errorResponse(
          null,
          -32600,
          `batch size ${body.length} exceeds limit ${this.config.security.maxBatchSize}`,
        );
      }
      const responses = await this.handleBatch(body, metrics);
      log();
      record("ok");
      return responses;
    }
    const response = await this.handleSingle(body, metrics);
    log();
    record(response.error === undefined ? "ok" : "error");
    return response;
  }

  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  /**
   * Reject blocked methods and oversized eth_getLogs ranges before any
   * cache or upstream work. Returns an error response, or null when the
   * request may proceed.
   */
  private guardRequest(request: JsonRpcRequest): JsonRpcResponse | null {
    if (isMethodBlocked(request.method, this.config.security)) {
      return errorResponse(request.id, -32601, "method not allowed");
    }
    if (request.method === "eth_getLogs") {
      const params = Array.isArray(request.params) ? request.params : [];
      const violation = logsRangeViolation(
        params,
        this.pool.chainHead,
        this.config.security,
      );
      if (violation !== null) {
        return errorResponse(request.id, -32602, violation);
      }
    }
    return null;
  }

  /** Cache policy for a request; everything is uncacheable when caching is off. */
  private policyFor(
    method: string,
    params: unknown[],
    ctx: CacheRuleContext,
  ): RequestPolicy {
    if (!this.config.cache.enabled) return { cacheable: false };
    return requestPolicy(method, params, ctx);
  }

  private ruleCtx(): CacheRuleContext {
    return {
      chainHead: this.pool.chainHead,
      shortTtlMs: computeShortTtlMs(
        this.pool.estimatedBlockIntervalMs,
        this.config.cache,
      ),
      pendingTtlMs: this.config.cache.pendingTtlMs,
      unfinalizedTtlMs: this.config.cache.unfinalizedTtlMs,
      finalityDepth: this.config.cache.finalityDepth,
    };
  }

  /** Cache key for a request: plain-text for the reorg-validated methods, hashed otherwise. */
  private keyFor(method: string, params: unknown[]): string {
    return RAW_KEY_METHODS.has(method)
      ? rawCacheKey(method, normalizeRawKeyParams(method, params))
      : cacheKey(method, params);
  }

  /**
   * Read a cache entry, returning the parsed payload on hit, null on miss.
   * For the reorg-validated methods the entry is checked against the reorg
   * detector's canonical-chain view: a height whose canonical hash no longer
   * matches the entry's stamp was reorged — the entry is stale, deleted in
   * the background, and reported as a miss. Entries that cannot be validated
   * (unstamped, null stamp, window gap, detector off) are trusted as-is;
   * the TTL remains the fallback for those.
   */
  private async validatedGet(method: string, key: string): Promise<unknown | null> {
    const raw = await this.cache.get(key);
    if (raw === null) return null;
    if (!RAW_KEY_METHODS.has(method)) return JSON.parse(raw);

    let height: number | null = null;
    let blockHash: string | null = null;
    let payload: unknown;
    const wrapped = parseValidatedEntry(raw);
    if (wrapped !== null) {
      height = wrapped.h;
      blockHash = wrapped.b;
      payload = wrapped.d;
    } else {
      payload = JSON.parse(raw);
      // Unwrapped payloads (finalized entries, mined tx/receipt results)
      // carry their own block coordinates: block payloads as number/hash,
      // transaction and receipt payloads as blockNumber/blockHash.
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const obj = payload as Record<string, unknown>;
        const bh = obj.blockHash ?? obj.hash;
        const bn = obj.blockNumber ?? obj.number;
        if (typeof bh === "string") {
          blockHash = bh;
          height = typeof bn === "string" ? parseQuantity(bn) : null;
        }
      }
    }
    if (height === null || blockHash === null) return payload;
    const canonical = this.pool.canonicalHashAt(height);
    if (canonical === null || canonical === blockHash) return payload;
    void this.cache.delete(key);
    return null;
  }

  /** Answer eth_blockNumber from the locally observed pool head. */
  private localBlockNumber(id: JsonRpcRequest["id"]): JsonRpcResponse | null {
    const head = this.pool.chainHead;
    if (head === null) return null;
    return { jsonrpc: "2.0", id, result: `0x${head.toString(16)}` };
  }

  /**
   * Warm the response cache from a newHeads payload, so the fresh head is
   * served as if eth_getBlockByNumber / eth_getBlockByHash had already been
   * called for it.
   *
   * Most clients push a bare header (no transactions field); the block is
   * then fetched once from the announcing upstream to cache a complete,
   * correct answer. When the payload already carries the transaction list
   * (e.g. geth's includeTransactions extension) it is cached directly.
   * Best-effort: failures are logged, never thrown. Entries use the short
   * head TTL so a reorged head expires quickly.
   */
  async warmBlockFromHead(
    upstreamName: string,
    head: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.cache.enabled) return;
    const hash = typeof head.hash === "string" ? head.hash : null;
    if (hash === null || typeof head.number !== "string") return;
    if (this.warmedHeads.has(hash)) return;
    this.warmedHeads.add(hash);
    if (this.warmedHeads.size > 256) {
      const oldest = this.warmedHeads.values().next().value;
      if (oldest !== undefined) this.warmedHeads.delete(oldest);
    }

    try {
      if (Array.isArray(head.transactions)) {
        await this.storeHeadedBlock(head);
        return;
      }
      const pinned = this.pool.byName(upstreamName);
      if (pinned === undefined) return;
      const body = await pinned.call({
        jsonrpc: "2.0",
        id: 0,
        method: "eth_getBlockByHash",
        params: [hash, false],
      });
      upstreamRequests.inc({ upstream: upstreamName, result: "ok" });
      const response = Array.isArray(body) ? body[0] : body;
      if (
        response !== undefined &&
        response.error === undefined &&
        typeof response.result === "object" &&
        response.result !== null
      ) {
        await this.storeHeadedBlock(response.result as Record<string, unknown>);
      }
    } catch (err) {
      upstreamRequests.inc({ upstream: upstreamName, result: "error" });
      this.logger?.warn(`head cache warming failed for ${hash}`, err);
    }
  }

  /**
   * Store a block object under the cache keys of the common
   * eth_getBlockByNumber / eth_getBlockByHash call shapes. The fullTx=false
   * shapes (including the omitted-flag form) require transactions as hashes;
   * the fullTx=true shapes are only written when full transaction objects
   * are present (or the block is empty, where both shapes coincide).
   *
   * Number-keyed entries use the plain-text key plus a validation stamp
   * (the head's own height and hash) with the unfinalized TTL: a reorged
   * head is then invalidated on read instead of expiring blindly. Hash-keyed
   * entries keep the hashed key and the short head TTL.
   */
  private async storeHeadedBlock(block: Record<string, unknown>): Promise<void> {
    const hash = typeof block.hash === "string" ? block.hash : null;
    const numberHex = typeof block.number === "string" ? block.number : null;
    const blockNumber = numberHex !== null ? parseQuantity(numberHex) : null;
    if (hash === null || numberHex === null || blockNumber === null) return;
    const shortTtlMs = computeShortTtlMs(
      this.pool.estimatedBlockIntervalMs,
      this.config.cache,
    );
    const unfinalizedTtlMs = this.config.cache.unfinalizedTtlMs;

    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    const hasFullTx = txs.length > 0 && typeof txs[0] === "object" && txs[0] !== null;
    const asHashes = hasFullTx
      ? {
          ...block,
          transactions: txs.map(
            (t) => (t as Record<string, unknown>).hash,
          ),
        }
      : block;

    const numberValues: { params: unknown[]; value: unknown }[] = [
      { params: [numberHex], value: asHashes },
      { params: [numberHex, false], value: asHashes },
    ];
    const hashValues: { params: unknown[]; value: unknown }[] = [
      { params: [hash], value: asHashes },
      { params: [hash, false], value: asHashes },
    ];
    if (hasFullTx || txs.length === 0) {
      numberValues.push({ params: [numberHex, true], value: block });
      hashValues.push({ params: [hash, true], value: block });
    }
    await Promise.all([
      ...numberValues.map((e) =>
        this.cache.set(
          rawCacheKey(
            "eth_getBlockByNumber",
            normalizeRawKeyParams("eth_getBlockByNumber", e.params),
          ),
          wrapValidatedEntry(blockNumber, hash, e.value),
          unfinalizedTtlMs,
        ),
      ),
      ...hashValues.map((e) =>
        this.cache.set(
          cacheKey("eth_getBlockByHash", e.params),
          JSON.stringify(e.value),
          shortTtlMs,
        ),
      ),
    ]);
  }

  private async handleBatch(
    body: unknown[],
    metrics: RequestMetrics,
  ): Promise<JsonRpcResponse[]> {
    const ctx = this.ruleCtx();
    const results: (JsonRpcResponse | null)[] = new Array(body.length).fill(null);
    const caches: CacheOutcome[] = new Array(body.length).fill("error");
    const misses: {
      index: number;
      request: JsonRpcRequest;
      original: JsonRpcRequest;
      minBlock: number | null;
      key: string | null;
    }[] = [];

    // 1. Validate, translate "latest", and serve from cache where possible.
    await Promise.all(
      body.map(async (item, index) => {
        if (!isJsonRpcRequest(item)) {
          results[index] = errorResponse(null, -32600, "Invalid Request");
          caches[index] = "error";
          return;
        }
        const original = item;
        const rejection = this.guardRequest(original);
        if (rejection !== null) {
          results[index] = rejection;
          caches[index] = "error";
          return;
        }
        if (original.method === "eth_blockNumber") {
          const local = this.localBlockNumber(original.id);
          if (local !== null) {
            this.localAnswers.blockNumber += 1;
            results[index] = local;
            caches[index] = "local";
            return;
          }
        }
        // Filter calls route per-item (possibly to a pinned upstream), so they
        // never join the shared batch forwarding path.
        if (isFilterMethod(original.method)) {
          const { response, outcome } = await this.handleFilterCall(original, metrics);
          if (outcome === "local") this.localAnswers.filters += 1;
          results[index] = response;
          caches[index] = outcome;
          return;
        }
        const { request, minBlock } = translateLatest(original, this.pool.chainHead);
        const params = Array.isArray(request.params) ? request.params : [];
        const policy = this.policyFor(request.method, params, ctx);
        if (!policy.cacheable) {
          misses.push({ index, request, original, minBlock, key: null });
          caches[index] = "miss";
          return;
        }
        const key = this.keyFor(request.method, params);
        const cached = await this.validatedGet(request.method, key);
        if (cached !== null) {
          results[index] = {
            jsonrpc: "2.0",
            id: request.id,
            result: cached,
          };
          caches[index] = "hit";
          return;
        }
        misses.push({ index, request, original, minBlock, key });
        caches[index] = "miss";
      }),
    );

    // 2. Non-cacheable misses go upstream as one batch, merged by id.
    //    Cacheable misses go through the single-flight path per key.
    const plainMisses = misses.filter((m) => m.key === null);
    const cacheableMisses = misses.filter((m) => m.key !== null);

    if (plainMisses.length > 0) {
      const minBlocks = plainMisses
        .map((m) => m.minBlock)
        .filter((b): b is number => b !== null);
      const { responses, upstreamMs, upstreamName } = await this.forwardBatch(
        plainMisses.map((m) => m.request),
        {
          minBlock: minBlocks.length > 0 ? Math.max(...minBlocks) : undefined,
          downgradeTo: plainMisses.map((m) => m.original),
        },
      );
      metrics.upstreamMs += upstreamMs;
      if (upstreamName) metrics.upstreamNames.add(upstreamName);
      const byId = new Map<string, JsonRpcResponse>();
      for (const r of responses) byId.set(JSON.stringify(r.id), r);

      for (const { index, request } of plainMisses) {
        const response = byId.get(JSON.stringify(request.id));
        results[index] =
          response ??
          errorResponse(request.id, -32003, "upstream did not answer this batch item");
      }
    }

    await Promise.all(
      cacheableMisses.map(async ({ index, request, original, minBlock, key }) => {
        const { response, upstreamMs, upstreamName } = await this.fetchAndStore(
          request,
          key!,
          ctx,
          {
            minBlock: minBlock ?? undefined,
            downgradeTo: original,
          },
        );
        results[index] = response;
        metrics.upstreamMs += upstreamMs;
        if (upstreamName) metrics.upstreamNames.add(upstreamName);
      }),
    );

    metrics.cacheSummary = formatCacheSummary(caches);
    return results as JsonRpcResponse[];
  }

  private async handleSingle(
    body: unknown,
    metrics: RequestMetrics,
  ): Promise<JsonRpcResponse> {
    if (!isJsonRpcRequest(body)) {
      metrics.cacheSummary = "error";
      return errorResponse(null, -32600, "Invalid Request");
    }
    const original = body;
    const rejection = this.guardRequest(original);
    if (rejection !== null) {
      metrics.cacheSummary = "error";
      return rejection;
    }
    if (original.method === "eth_blockNumber") {
      const local = this.localBlockNumber(original.id);
      if (local !== null) {
        this.localAnswers.blockNumber += 1;
        metrics.cacheSummary = "local";
        return local;
      }
    }
    if (isFilterMethod(original.method)) {
      const { response, outcome } = await this.handleFilterCall(original, metrics);
      if (outcome === "local") this.localAnswers.filters += 1;
      metrics.cacheSummary = outcome;
      return response;
    }
    const { request, minBlock } = translateLatest(original, this.pool.chainHead);
    const params = Array.isArray(request.params) ? request.params : [];
    const ctx = this.ruleCtx();
    const policy = this.policyFor(request.method, params, ctx);

    if (policy.cacheable) {
      const key = this.keyFor(request.method, params);
      const cached = await this.validatedGet(request.method, key);
      if (cached !== null) {
        metrics.cacheSummary = "hit";
        return { jsonrpc: "2.0", id: request.id, result: cached };
      }
      const { response, upstreamMs, upstreamName } = await this.fetchAndStore(
        request,
        key,
        ctx,
        {
          minBlock: minBlock ?? undefined,
          downgradeTo: original,
        },
      );
      metrics.upstreamMs += upstreamMs;
      if (upstreamName) metrics.upstreamNames.add(upstreamName);
      metrics.cacheSummary = "miss";
      return response;
    }

    const { responses, upstreamMs, upstreamName } = await this.forwardBatch(
      [request],
      {
        minBlock: minBlock ?? undefined,
        downgradeTo: [original],
      },
    );
    metrics.upstreamMs += upstreamMs;
    if (upstreamName) metrics.upstreamNames.add(upstreamName);
    metrics.cacheSummary = "miss";
    return responses[0] ?? errorResponse(request.id, -32003, "upstream error");
  }

  /**
   * Fetch one cacheable entry from upstream with single-flight coalescing:
   * the first miss for a key becomes the leader and performs the upstream
   * call + cache store; concurrent followers await the same promise and
   * receive the result with their own request id.
   */
  private fetchAndStore(
    request: JsonRpcRequest,
    key: string,
    ctx: CacheRuleContext,
    opts: { minBlock?: number; downgradeTo?: JsonRpcRequest } = {},
  ): Promise<{ response: JsonRpcResponse; upstreamMs: number; upstreamName?: string }> {
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const { responses, downgraded, upstreamMs, upstreamName } =
          await this.forwardBatch([request], {
            minBlock: opts.minBlock,
            downgradeTo: opts.downgradeTo ? [opts.downgradeTo] : undefined,
          });
        const response = responses[0];
        if (!response) {
          return {
            response: errorResponse(request.id, -32003, "upstream error"),
            upstreamMs,
            upstreamName,
          };
        }
        // A downgraded response came from a node without the target block;
        // it is not the data the cache key promises, so never store it.
        if (!downgraded && response.error === undefined) {
          await this.storeResult(request, response, key, ctx);
        }
        return { response, upstreamMs, upstreamName };
      })();
      this.inflight.set(key, pending);
      void pending.finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      });
    }
    return pending.then(({ response, upstreamMs, upstreamName }) => ({
      response: { ...response, id: request.id },
      upstreamMs,
      upstreamName,
    }));
  }

  /**
   * Handle one filter call. Two paths:
   *
   * - eth_newBlockFilter is served locally when the pool tracks heads via
   *   its own upstream newHeads subscriptions (health.wsHeads): the proxy
   *   issues the id and answers polls from its rolling head buffer, with no
   *   upstream involvement at all.
   * - Everything else uses sticky routing. Filter state lives in a single
   *   node's memory and ids are node-local, so creation is forwarded through
   *   the normal pool and the node-local id in the response is replaced by a
   *   proxy-issued id recorded in the sticky table; polling / uninstall
   *   rewrite params[0] back to the node-local id and are pinned to the
   *   owning upstream — failover to another node is pointless, the filter
   *   does not exist there.
   */
  private async handleFilterCall(
    request: JsonRpcRequest,
    metrics: RequestMetrics,
  ): Promise<{ response: JsonRpcResponse; outcome: CacheOutcome }> {
    if (request.method === "eth_newBlockFilter" && this.pool.localHeadsEnabled) {
      return this.createLocalBlockFilter(request);
    }

    if (FILTER_CREATE_METHODS.has(request.method)) {
      const { responses, upstreamMs, upstreamName } = await this.forwardBatch([
        request,
      ]);
      metrics.upstreamMs += upstreamMs;
      if (upstreamName) metrics.upstreamNames.add(upstreamName);
      const response =
        responses[0] ?? errorResponse(request.id, -32003, "upstream error");
      if (
        response.error === undefined &&
        typeof response.result === "string" &&
        upstreamName !== undefined
      ) {
        const proxyId = this.filters.register(upstreamName, response.result);
        return { response: { ...response, result: proxyId }, outcome: "miss" };
      }
      return { response, outcome: "miss" };
    }

    const params = Array.isArray(request.params) ? request.params : [];
    const proxyId = typeof params[0] === "string" ? params[0] : "";

    // Locally served block filters take precedence; ids are proxy-issued.
    if (
      FILTER_POLL_METHODS.has(request.method) ||
      request.method === FILTER_UNINSTALL_METHOD
    ) {
      const local =
        this.localBlockFilters.size > 0
          ? this.lookupLocalBlockFilter(proxyId)
          : null;
      if (local !== null) {
        if (request.method === FILTER_UNINSTALL_METHOD) {
          this.localBlockFilters.delete(proxyId);
          return {
            response: { jsonrpc: "2.0", id: request.id, result: true },
            outcome: "local",
          };
        }
        const fresh = this.recentHeads.filter((h) => h.number > local.cursor);
        fresh.sort((a, b) => a.number - b.number);
        if (fresh.length > 0) local.cursor = fresh[fresh.length - 1]!.number;
        return {
          response: {
            jsonrpc: "2.0",
            id: request.id,
            result: fresh.map((h) => h.hash),
          },
          outcome: "local",
        };
      }
    }

    const mapping = this.filters.lookup(proxyId);
    if (mapping === null) {
      // Mirrors node behaviour for unknown/expired filters.
      if (request.method === FILTER_UNINSTALL_METHOD) {
        return {
          response: { jsonrpc: "2.0", id: request.id, result: false },
          outcome: "local",
        };
      }
      return {
        response: errorResponse(request.id, -32000, "filter not found"),
        outcome: "local",
      };
    }

    const pinned = this.pool.byName(mapping.upstreamName);
    if (pinned === undefined) {
      this.filters.remove(proxyId);
      return {
        response: errorResponse(request.id, -32000, "filter not found"),
        outcome: "local",
      };
    }

    const rewritten = { ...request, params: [mapping.nodeId, ...params.slice(1)] };
    const { responses, upstreamMs, upstreamName } = await this.forwardBatch(
      [rewritten],
      { pinned },
    );
    metrics.upstreamMs += upstreamMs;
    if (upstreamName) metrics.upstreamNames.add(upstreamName);
    const response =
      responses[0] ?? errorResponse(request.id, -32003, "upstream error");
    if (
      request.method === FILTER_UNINSTALL_METHOD &&
      response.error === undefined
    ) {
      this.filters.remove(proxyId);
    }
    return { response, outcome: "miss" };
  }

  /**
   * Create a locally served block filter. The cursor starts at the current
   * pool head: only heads observed after creation are reported, matching
   * node behaviour. Idle filters expire after filters.stickyTtlMs, aligning
   * with the node-side filter timeout.
   */
  private createLocalBlockFilter(
    request: JsonRpcRequest,
  ): { response: JsonRpcResponse; outcome: CacheOutcome } {
    const now = Date.now();
    for (const [id, f] of this.localBlockFilters) {
      if (f.expiresAt <= now) this.localBlockFilters.delete(id);
    }
    const id = `0x${randomBytes(16).toString("hex")}`;
    this.localBlockFilters.set(id, {
      cursor: this.pool.chainHead ?? 0,
      expiresAt: now + this.config.filters.stickyTtlMs,
    });
    return {
      response: { jsonrpc: "2.0", id: request.id, result: id },
      outcome: "local",
    };
  }

  /** Resolve a local block filter; refreshes its idle expiry on hit. */
  private lookupLocalBlockFilter(
    id: string,
  ): { cursor: number; expiresAt: number } | null {
    const f = this.localBlockFilters.get(id);
    if (f === undefined) return null;
    const now = Date.now();
    if (f.expiresAt <= now) {
      this.localBlockFilters.delete(id);
      return null;
    }
    f.expiresAt = now + this.config.filters.stickyTtlMs;
    return f;
  }

  /**
   * Forward a batch of requests to the pool, retrying on a different
   * upstream on transport-level failures only. Never retried when the batch
   * contains a side-effecting method (eth_sendRawTransaction etc.).
   *
   * With minBlock set, only upstreams that have that block are considered;
   * when none qualify, the selection is retried without the constraint and
   * the downgradeTo requests (with the original "latest" tags) are sent
   * instead — slightly stale data beats an error. downgraded tells callers
   * not to cache the response.
   *
   * With pinned set, the request goes to exactly that upstream in a single
   * attempt regardless of its health flags (used by sticky filter routing:
   * the filter state exists on that node alone). upstreamName reports which
   * upstream actually answered.
   */
  private async forwardBatch(
    requests: JsonRpcRequest[],
    opts: {
      minBlock?: number;
      downgradeTo?: JsonRpcRequest[];
      pinned?: Upstream;
    } = {},
  ): Promise<{
    responses: JsonRpcResponse[];
    downgraded: boolean;
    upstreamMs: number;
    upstreamName?: string;
  }> {
    const noRetry = requests.some((r) => NO_RETRY_METHODS.has(r.method));
    const attempts = noRetry || opts.pinned ? 1 : this.config.health.maxRetries;
    let picks = opts.pinned
      ? [opts.pinned]
      : this.pool.select(attempts, opts.minBlock);
    let downgraded = false;
    let upstreamMs = 0;

    if (picks.length === 0 && opts.minBlock !== undefined) {
      picks = this.pool.select(attempts);
      downgraded = true;
      if (opts.downgradeTo) requests = opts.downgradeTo;
    }
    if (picks.length === 0) {
      return {
        responses: requests.map((r) =>
          errorResponse(r.id, -32002, "no healthy upstream available"),
        ),
        downgraded,
        upstreamMs,
      };
    }

    const payload = requests.length === 1 ? requests[0] : requests;
    for (const [attemptIndex, upstream] of picks.entries()) {
      // Exponential backoff between attempts (no delay before the first).
      if (attemptIndex > 0) {
        await sleep(retryDelayMs(attemptIndex, this.config.health));
      }
      try {
        const callStart = performance.now();
        const body = await upstream.call(payload);
        upstreamMs += performance.now() - callStart;
        upstreamRequests.inc({ upstream: upstream.name, result: "ok" });
        const responses = Array.isArray(body) ? body : [body];
        // A legal JSON-RPC error from the upstream is a definitive answer,
        // not a reason to fail over.
        return { responses, downgraded, upstreamMs, upstreamName: upstream.name };
      } catch (err) {
        if (err instanceof UpstreamTransportError) {
          upstreamRequests.inc({ upstream: upstream.name, result: "error" });
          this.logger?.warn(
            `forwarding to ${upstream.name} failed, trying next upstream`,
            err.cause ?? err.message,
          );
          continue;
        }
        throw err;
      }
    }

    return {
      responses: requests.map((r) =>
        errorResponse(r.id, -32003, "all upstreams failed"),
      ),
      downgraded,
      upstreamMs,
    };
  }

  private async storeResult(
    request: JsonRpcRequest,
    response: JsonRpcResponse,
    key: string,
    ctx: CacheRuleContext,
  ): Promise<void> {
    if (response.result === undefined) return;
    const params = Array.isArray(request.params) ? request.params : [];
    const policy = requestPolicy(request.method, params, ctx);
    if (!policy.cacheable) return;

    const ttlMs =
      policy.ttlMs === "by-response"
        ? responseTtl(request.method, response.result, ctx)
        : policy.ttlMs;
    if (ttlMs === false) return;

    // Number-keyed entries below finalityDepth carry a validation stamp:
    // the height plus the canonical hash observed at write time.
    const value =
      policy.stampHeight !== undefined
        ? wrapValidatedEntry(
            policy.stampHeight,
            this.pool.canonicalHashAt(policy.stampHeight),
            response.result,
          )
        : JSON.stringify(response.result);
    await this.cache.set(key, value, ttlMs);
  }
}
