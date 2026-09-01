import { cacheKey, ResponseCache, type CacheStats } from "./cache/index.js";
import { requestPolicy, responseTtl, type CacheRuleContext, type RequestPolicy } from "./cache-rules.js";
import type { Config } from "./config.js";
import {
  FILTER_CREATE_METHODS,
  FILTER_UNINSTALL_METHOD,
  isFilterMethod,
  StickyFilterRouter,
} from "./filters.js";
import type { UpstreamPool } from "./pool.js";
import {
  errorResponse,
  formatRequestForLog,
  isJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./rpc.js";
import { isMethodBlocked, logsRangeViolation } from "./security.js";
import { rpcDuration, rpcRequests, upstreamRequests } from "./metrics.js";
import { translateLatest } from "./translate.js";
import { Upstream, UpstreamTransportError } from "./upstream.js";

export interface ProxyLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

type CacheOutcome = "hit" | "miss" | "local" | "error";

interface RequestMetrics {
  upstreamMs: number;
  cacheSummary: string;
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
    Promise<{ response: JsonRpcResponse; upstreamMs: number }>
  >();

  constructor(
    private readonly pool: UpstreamPool,
    private readonly cache: ResponseCache,
    private readonly config: Config,
    private readonly filters: StickyFilterRouter = new StickyFilterRouter(
      config.filters.stickyTtlMs,
    ),
    private readonly logger?: ProxyLogger,
  ) {}

  async handle(
    body: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    const startedAt = performance.now();
    const metrics: RequestMetrics = { upstreamMs: 0, cacheSummary: "error" };
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
      this.logger?.info(
        `request: ${formatRequestForLog(body)} | cache=${metrics.cacheSummary} | upstreamMs=${upstreamMs} | totalMs=${totalMs}`,
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
      finalityDepth: this.config.cache.finalityDepth,
    };
  }

  /** Answer eth_blockNumber from the locally observed pool head. */
  private localBlockNumber(id: JsonRpcRequest["id"]): JsonRpcResponse | null {
    const head = this.pool.chainHead;
    if (head === null) return null;
    return { jsonrpc: "2.0", id, result: `0x${head.toString(16)}` };
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
            results[index] = local;
            caches[index] = "local";
            return;
          }
        }
        // Filter calls route per-item (possibly to a pinned upstream), so they
        // never join the shared batch forwarding path.
        if (isFilterMethod(original.method)) {
          const { response, outcome } = await this.handleFilterCall(original, metrics);
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
        const key = cacheKey(request.method, params);
        const cached = await this.cache.get(key);
        if (cached !== null) {
          results[index] = {
            jsonrpc: "2.0",
            id: request.id,
            result: JSON.parse(cached),
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
      const { responses, upstreamMs } = await this.forwardBatch(
        plainMisses.map((m) => m.request),
        {
          minBlock: minBlocks.length > 0 ? Math.max(...minBlocks) : undefined,
          downgradeTo: plainMisses.map((m) => m.original),
        },
      );
      metrics.upstreamMs += upstreamMs;
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
        const { response, upstreamMs } = await this.fetchAndStore(request, key!, ctx, {
          minBlock: minBlock ?? undefined,
          downgradeTo: original,
        });
        results[index] = response;
        metrics.upstreamMs += upstreamMs;
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
        metrics.cacheSummary = "local";
        return local;
      }
    }
    if (isFilterMethod(original.method)) {
      const { response, outcome } = await this.handleFilterCall(original, metrics);
      metrics.cacheSummary = outcome;
      return response;
    }
    const { request, minBlock } = translateLatest(original, this.pool.chainHead);
    const params = Array.isArray(request.params) ? request.params : [];
    const ctx = this.ruleCtx();
    const policy = this.policyFor(request.method, params, ctx);

    if (policy.cacheable) {
      const key = cacheKey(request.method, params);
      const cached = await this.cache.get(key);
      if (cached !== null) {
        metrics.cacheSummary = "hit";
        return { jsonrpc: "2.0", id: request.id, result: JSON.parse(cached) };
      }
      const { response, upstreamMs } = await this.fetchAndStore(request, key, ctx, {
        minBlock: minBlock ?? undefined,
        downgradeTo: original,
      });
      metrics.upstreamMs += upstreamMs;
      metrics.cacheSummary = "miss";
      return response;
    }

    const { responses, upstreamMs } = await this.forwardBatch([request], {
      minBlock: minBlock ?? undefined,
      downgradeTo: [original],
    });
    metrics.upstreamMs += upstreamMs;
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
  ): Promise<{ response: JsonRpcResponse; upstreamMs: number }> {
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const { responses, downgraded, upstreamMs } = await this.forwardBatch(
          [request],
          {
            minBlock: opts.minBlock,
            downgradeTo: opts.downgradeTo ? [opts.downgradeTo] : undefined,
          },
        );
        const response = responses[0];
        if (!response) {
          return {
            response: errorResponse(request.id, -32003, "upstream error"),
            upstreamMs,
          };
        }
        // A downgraded response came from a node without the target block;
        // it is not the data the cache key promises, so never store it.
        if (!downgraded && response.error === undefined) {
          await this.storeResult(request, response, key, ctx);
        }
        return { response, upstreamMs };
      })();
      this.inflight.set(key, pending);
      void pending.finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      });
    }
    return pending.then(({ response, upstreamMs }) => ({
      response: { ...response, id: request.id },
      upstreamMs,
    }));
  }

  /**
   * Handle one filter call with sticky routing.
   *
   * Filter state lives in a single node's memory and ids are node-local, so:
   * - creation is forwarded through the normal pool; the node-local id in the
   *   response is replaced by a proxy-issued id recorded in the sticky table;
   * - polling / uninstall rewrite params[0] back to the node-local id and are
   *   pinned to the upstream that owns the filter — failover to another node
   *   is pointless, the filter does not exist there.
   */
  private async handleFilterCall(
    request: JsonRpcRequest,
    metrics: RequestMetrics,
  ): Promise<{ response: JsonRpcResponse; outcome: CacheOutcome }> {
    if (FILTER_CREATE_METHODS.has(request.method)) {
      const { responses, upstreamMs, upstreamName } = await this.forwardBatch([
        request,
      ]);
      metrics.upstreamMs += upstreamMs;
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
    const { responses, upstreamMs } = await this.forwardBatch([rewritten], {
      pinned,
    });
    metrics.upstreamMs += upstreamMs;
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

    await this.cache.set(key, JSON.stringify(response.result), ttlMs);
  }
}
