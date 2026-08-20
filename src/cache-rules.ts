import { parseQuantity } from "./rpc.js";

export interface CacheRuleContext {
  /** Highest block number known across the pool; null when unknown. */
  chainHead: number | null;
  shortTtlMs: number;
  pendingTtlMs: number;
  finalityDepth: number;
}

export const LONG_TTL_MS = 60 * 60 * 1000; // chain id, client version, etc.

/**
 * Request-stage cache policy.
 * - cacheable: false            -> never touch the cache
 * - ttlMs: number | null        -> store response with this TTL (null = no expiry)
 * - ttlMs: "by-response"        -> TTL decided from the response via responseTtl()
 */
export type RequestPolicy =
  | { cacheable: false }
  | { cacheable: true; ttlMs: number | null | "by-response" };

const NOT_CACHEABLE: RequestPolicy = { cacheable: false };

const BLOCK_TAGS = new Set(["latest", "earliest", "pending", "safe", "finalized"]);

/** Methods whose params locate data by an immutable hash (block hash, tx hash). */
const HASH_KEYED_METHODS = new Set([
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleCountByBlockHash",
]);

/** Methods whose first param is a block number/tag and whose result is immutable once finalized. */
const NUMBER_KEYED_METHODS = new Set([
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByNumber",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getUncleByBlockNumberAndIndex",
  "eth_getUncleCountByBlockNumber",
]);

/** State queries: method -> index of the block tag param. */
const STATE_METHOD_TAG_INDEX: Record<string, number> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
};

const SHORT_TTL_METHODS = new Set([
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
]);

const LONG_TTL_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_protocolVersion",
]);

function isFinalized(blockNumber: number, ctx: CacheRuleContext): boolean {
  if (ctx.chainHead === null) return false;
  return blockNumber <= ctx.chainHead - ctx.finalityDepth;
}

/**
 * Policy for a request that carries a block number/tag in `tag`.
 * "pending" and blocks beyond the known head are never cacheable;
 * deep-enough blocks are permanent; anything near the head is short-TTL.
 */
function blockTagPolicy(tag: unknown, ctx: CacheRuleContext): RequestPolicy {
  if (tag === undefined) return { cacheable: true, ttlMs: ctx.shortTtlMs }; // defaults to "latest"
  if (typeof tag === "string" && BLOCK_TAGS.has(tag)) {
    if (tag === "pending") return NOT_CACHEABLE;
    if (tag === "earliest") return { cacheable: true, ttlMs: null }; // genesis is immutable
    return { cacheable: true, ttlMs: ctx.shortTtlMs };
  }
  const n = parseQuantity(tag);
  if (n === null) return NOT_CACHEABLE;
  if (ctx.chainHead !== null && n > ctx.chainHead) return NOT_CACHEABLE; // future block
  return isFinalized(n, ctx)
    ? { cacheable: true, ttlMs: null }
    : { cacheable: true, ttlMs: ctx.shortTtlMs };
}

function logsPolicy(params: unknown[], ctx: CacheRuleContext): RequestPolicy {
  const filter = params[0];
  if (typeof filter !== "object" || filter === null) return NOT_CACHEABLE;
  const { fromBlock, toBlock } = filter as Record<string, unknown>;
  if (fromBlock === "pending" || toBlock === "pending") return NOT_CACHEABLE;
  const from = fromBlock === undefined ? null : parseQuantity(fromBlock);
  const to = toBlock === undefined ? null : parseQuantity(toBlock);
  if (from === null || to === null) {
    // "latest"/"earliest"/missing bounds: near-head, short TTL
    return { cacheable: true, ttlMs: ctx.shortTtlMs };
  }
  return isFinalized(to, ctx)
    ? { cacheable: true, ttlMs: null }
    : { cacheable: true, ttlMs: ctx.shortTtlMs };
}

export function requestPolicy(
  method: string,
  params: unknown[],
  ctx: CacheRuleContext,
): RequestPolicy {
  if (HASH_KEYED_METHODS.has(method)) {
    // Hash-keyed data is immutable, but a null result may just mean the node
    // is behind / the tx is not mined yet — decide from the response.
    return { cacheable: true, ttlMs: "by-response" };
  }

  if (method === "eth_getTransactionReceipt") {
    return { cacheable: true, ttlMs: "by-response" };
  }

  if (NUMBER_KEYED_METHODS.has(method)) {
    return blockTagPolicy(params[0], ctx);
  }

  if (method in STATE_METHOD_TAG_INDEX) {
    return blockTagPolicy(params[STATE_METHOD_TAG_INDEX[method]!], ctx);
  }

  if (method === "eth_getLogs") {
    return logsPolicy(params, ctx);
  }

  if (method === "eth_feeHistory") {
    return { cacheable: true, ttlMs: ctx.shortTtlMs };
  }

  if (SHORT_TTL_METHODS.has(method)) {
    return { cacheable: true, ttlMs: ctx.shortTtlMs };
  }

  if (LONG_TTL_METHODS.has(method)) {
    return { cacheable: true, ttlMs: LONG_TTL_MS };
  }

  // Unknown, write/stateful or admin/debug methods: fail safe, never cache.
  return NOT_CACHEABLE;
}

/**
 * Response-stage TTL for "by-response" policies.
 * Returns the TTL in ms, null for no expiry, or false to skip storing.
 */
export function responseTtl(
  method: string,
  result: unknown,
  ctx: CacheRuleContext,
): number | null | false {
  if (method === "eth_getTransactionReceipt") {
    if (result === null || result === undefined) return ctx.pendingTtlMs;
    const blockHash = (result as Record<string, unknown>).blockHash;
    return typeof blockHash === "string" && blockHash.length > 0
      ? null // mined: immutable
      : ctx.pendingTtlMs;
  }
  // Hash-keyed lookups: real data is immutable; null may become available later.
  if (result === null || result === undefined) return ctx.pendingTtlMs;
  return null;
}
