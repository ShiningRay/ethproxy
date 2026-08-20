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

export class ProxyHandler {
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
      return this.handleBatch(body);
    }
    return this.handleSingle(body);
  }

  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  private ruleCtx(): CacheRuleContext {
    return {
      chainHead: this.pool.chainHead,
      shortTtlMs: this.config.cache.shortTtlMs,
      pendingTtlMs: this.config.cache.pendingTtlMs,
      finalityDepth: this.config.cache.finalityDepth,
    };
  }

  private async handleBatch(body: unknown[]): Promise<JsonRpcResponse[]> {
    const ctx = this.ruleCtx();
    const results: (JsonRpcResponse | null)[] = new Array(body.length).fill(null);
    const misses: { index: number; request: JsonRpcRequest; key: string | null }[] = [];

    // 1. Validate and serve from cache where possible.
    await Promise.all(
      body.map(async (item, index) => {
        if (!isJsonRpcRequest(item)) {
          results[index] = errorResponse(null, -32600, "Invalid Request");
          return;
        }
        const request = item;
        const params = Array.isArray(request.params) ? request.params : [];
        const policy = requestPolicy(request.method, params, ctx);
        if (!policy.cacheable) {
          misses.push({ index, request, key: null });
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
        misses.push({ index, request, key });
      }),
    );

    // 2. Forward the misses as one batch, then merge by id.
    if (misses.length > 0) {
      const responses = await this.forwardBatch(misses.map((m) => m.request));
      const byId = new Map<string, JsonRpcResponse>();
      for (const r of responses) byId.set(JSON.stringify(r.id), r);

      await Promise.all(
        misses.map(async ({ index, request, key }) => {
          const response = byId.get(JSON.stringify(request.id));
          if (!response) {
            results[index] = errorResponse(
              request.id,
              -32003,
              "upstream did not answer this batch item",
            );
            return;
          }
          results[index] = response;
          if (key !== null && response.error === undefined) {
            await this.storeResult(request, response, key, ctx);
          }
        }),
      );
    }

    return results as JsonRpcResponse[];
  }

  private async handleSingle(body: unknown): Promise<JsonRpcResponse> {
    if (!isJsonRpcRequest(body)) {
      return errorResponse(null, -32600, "Invalid Request");
    }
    const request = body;
    const params = Array.isArray(request.params) ? request.params : [];
    const ctx = this.ruleCtx();
    const policy = requestPolicy(request.method, params, ctx);

    let key: string | null = null;
    if (policy.cacheable) {
      key = cacheKey(request.method, params);
      const cached = await this.cache.get(key);
      if (cached !== null) {
        return { jsonrpc: "2.0", id: request.id, result: JSON.parse(cached) };
      }
    }

    const [response] = await this.forwardBatch([request]);
    if (!response) {
      return errorResponse(request.id, -32003, "upstream error");
    }
    if (key !== null && response.error === undefined) {
      await this.storeResult(request, response, key, ctx);
    }
    return response;
  }

  /**
   * Forward a batch of requests to the pool, retrying on a different
   * upstream on transport-level failures only. Never retried when the batch
   * contains a side-effecting method (eth_sendRawTransaction etc.).
   */
  private async forwardBatch(
    requests: JsonRpcRequest[],
  ): Promise<JsonRpcResponse[]> {
    const noRetry = requests.some((r) => NO_RETRY_METHODS.has(r.method));
    const attempts = noRetry ? 1 : this.config.health.maxRetries;
    const picks = this.pool.select(attempts);

    if (picks.length === 0) {
      return requests.map((r) =>
        errorResponse(r.id, -32002, "no healthy upstream available"),
      );
    }

    const payload = requests.length === 1 ? requests[0] : requests;
    for (const upstream of picks) {
      try {
        const body = await upstream.call(payload);
        const responses = Array.isArray(body) ? body : [body];
        // A legal JSON-RPC error from the upstream is a definitive answer,
        // not a reason to fail over.
        return responses;
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

    return requests.map((r) =>
      errorResponse(r.id, -32003, "all upstreams failed"),
    );
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
