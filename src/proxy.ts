import { cacheKey, ResponseCache, type CacheStats } from "./cache/index.js";
import { requestPolicy, responseTtl, type CacheRuleContext } from "./cache-rules.js";
import type { Config } from "./config.js";
import type { UpstreamPool } from "./pool.js";
import {
  errorResponse,
  isJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./rpc.js";
import { isMethodBlocked, logsRangeViolation } from "./security.js";
import { translateLatest } from "./translate.js";
import { UpstreamTransportError } from "./upstream.js";

export interface ProxyLogger {
  warn: (msg: string, ...args: unknown[]) => void;
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
  private readonly inflight = new Map<string, Promise<JsonRpcResponse>>();

  constructor(
    private readonly pool: UpstreamPool,
    private readonly cache: ResponseCache,
    private readonly config: Config,
    private readonly logger?: ProxyLogger,
  ) {}

  async handle(
    body: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return errorResponse(null, -32600, "Invalid Request: empty batch");
      }
      if (body.length > this.config.security.maxBatchSize) {
        return errorResponse(
          null,
          -32600,
          `batch size ${body.length} exceeds limit ${this.config.security.maxBatchSize}`,
        );
      }
      return this.handleBatch(body);
    }
    return this.handleSingle(body);
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

  private async handleBatch(body: unknown[]): Promise<JsonRpcResponse[]> {
    const ctx = this.ruleCtx();
    const results: (JsonRpcResponse | null)[] = new Array(body.length).fill(null);
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
          return;
        }
        const original = item;
        const rejection = this.guardRequest(original);
        if (rejection !== null) {
          results[index] = rejection;
          return;
        }
        if (original.method === "eth_blockNumber") {
          const local = this.localBlockNumber(original.id);
          if (local !== null) {
            results[index] = local;
            return;
          }
        }
        const { request, minBlock } = translateLatest(original, this.pool.chainHead);
        const params = Array.isArray(request.params) ? request.params : [];
        const policy = requestPolicy(request.method, params, ctx);
        if (!policy.cacheable) {
          misses.push({ index, request, original, minBlock, key: null });
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
          return;
        }
        misses.push({ index, request, original, minBlock, key });
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
      const { responses } = await this.forwardBatch(
        plainMisses.map((m) => m.request),
        {
          minBlock: minBlocks.length > 0 ? Math.max(...minBlocks) : undefined,
          downgradeTo: plainMisses.map((m) => m.original),
        },
      );
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
        results[index] = await this.fetchAndStore(request, key!, ctx, {
          minBlock: minBlock ?? undefined,
          downgradeTo: original,
        });
      }),
    );

    return results as JsonRpcResponse[];
  }

  private async handleSingle(body: unknown): Promise<JsonRpcResponse> {
    if (!isJsonRpcRequest(body)) {
      return errorResponse(null, -32600, "Invalid Request");
    }
    const original = body;
    const rejection = this.guardRequest(original);
    if (rejection !== null) return rejection;
    if (original.method === "eth_blockNumber") {
      const local = this.localBlockNumber(original.id);
      if (local !== null) return local;
    }
    const { request, minBlock } = translateLatest(original, this.pool.chainHead);
    const params = Array.isArray(request.params) ? request.params : [];
    const ctx = this.ruleCtx();
    const policy = requestPolicy(request.method, params, ctx);

    if (policy.cacheable) {
      const key = cacheKey(request.method, params);
      const cached = await this.cache.get(key);
      if (cached !== null) {
        return { jsonrpc: "2.0", id: request.id, result: JSON.parse(cached) };
      }
      return this.fetchAndStore(request, key, ctx, {
        minBlock: minBlock ?? undefined,
        downgradeTo: original,
      });
    }

    const { responses } = await this.forwardBatch([request], {
      minBlock: minBlock ?? undefined,
      downgradeTo: [original],
    });
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
  ): Promise<JsonRpcResponse> {
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const { responses, downgraded } = await this.forwardBatch([request], {
          minBlock: opts.minBlock,
          downgradeTo: opts.downgradeTo ? [opts.downgradeTo] : undefined,
        });
        const response = responses[0];
        if (!response) {
          return errorResponse(request.id, -32003, "upstream error");
        }
        // A downgraded response came from a node without the target block;
        // it is not the data the cache key promises, so never store it.
        if (!downgraded && response.error === undefined) {
          await this.storeResult(request, response, key, ctx);
        }
        return response;
      })();
      this.inflight.set(key, pending);
      void pending.finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      });
    }
    return pending.then((response) => ({ ...response, id: request.id }));
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
   */
  private async forwardBatch(
    requests: JsonRpcRequest[],
    opts: { minBlock?: number; downgradeTo?: JsonRpcRequest[] } = {},
  ): Promise<{ responses: JsonRpcResponse[]; downgraded: boolean }> {
    const noRetry = requests.some((r) => NO_RETRY_METHODS.has(r.method));
    const attempts = noRetry ? 1 : this.config.health.maxRetries;
    let picks = this.pool.select(attempts, opts.minBlock);
    let downgraded = false;

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
      };
    }

    const payload = requests.length === 1 ? requests[0] : requests;
    for (const [attemptIndex, upstream] of picks.entries()) {
      // Exponential backoff between attempts (no delay before the first).
      if (attemptIndex > 0) {
        await sleep(retryDelayMs(attemptIndex, this.config.health));
      }
      try {
        const body = await upstream.call(payload);
        const responses = Array.isArray(body) ? body : [body];
        // A legal JSON-RPC error from the upstream is a definitive answer,
        // not a reason to fail over.
        return { responses, downgraded };
      } catch (err) {
        if (err instanceof UpstreamTransportError) {
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
