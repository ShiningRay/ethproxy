import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";

/**
 * Process-wide metrics registry. Instruments are module singletons so the
 * proxy can record without plumbing; pool/cache gauges read through the
 * binding set by bindMetrics() (last bind wins — there is exactly one app
 * in production).
 */
export const registry = new Registry();

export const rpcRequests = new Counter({
  name: "ethproxy_rpc_requests_total",
  help: "JSON-RPC requests handled, by method and result",
  labelNames: ["method", "result"],
  registers: [registry],
});

export const rpcDuration = new Histogram({
  name: "ethproxy_rpc_request_duration_seconds",
  help: "JSON-RPC request handling time, by method",
  labelNames: ["method"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const upstreamRequests = new Counter({
  name: "ethproxy_upstream_requests_total",
  help: "Calls forwarded to upstreams, by upstream and result",
  labelNames: ["upstream", "result"],
  registers: [registry],
});

const upstreamHealthy = new Gauge({
  name: "ethproxy_upstream_healthy",
  help: "1 when the upstream is healthy and eligible, 0 otherwise",
  labelNames: ["upstream"],
  registers: [registry],
});

const upstreamWsHealthy = new Gauge({
  name: "ethproxy_upstream_ws_healthy",
  help: "1 when the upstream's WebSocket endpoint responds, 0 otherwise",
  labelNames: ["upstream"],
  registers: [registry],
});

const upstreamBlockNumber = new Gauge({
  name: "ethproxy_upstream_block_number",
  help: "Last reported block number of the upstream",
  labelNames: ["upstream"],
  registers: [registry],
});

const upstreamLatency = new Gauge({
  name: "ethproxy_upstream_latency_ms",
  help: "Rolling average health-poll round-trip time of the upstream",
  labelNames: ["upstream"],
  registers: [registry],
});

const chainHead = new Gauge({
  name: "ethproxy_chain_head",
  help: "Highest block number known across the pool",
  registers: [registry],
});

export const reorgsDetected = new Counter({
  name: "ethproxy_reorgs_detected_total",
  help: "Chain reorganizations confirmed from upstream head announcements",
  registers: [registry],
});

export const reorgDepth = new Histogram({
  name: "ethproxy_reorg_depth",
  help: "Number of replaced blocks per confirmed reorg (lower bound when inexact)",
  buckets: [1, 2, 3, 5, 8, 13, 21, 34],
  registers: [registry],
});

const cacheHits = new Gauge({
  name: "ethproxy_cache_hits_total",
  help: "Cache hits since process start",
  registers: [registry],
});
const cacheMisses = new Gauge({
  name: "ethproxy_cache_misses_total",
  help: "Cache misses since process start",
  registers: [registry],
});
const cacheStores = new Gauge({
  name: "ethproxy_cache_stores_total",
  help: "Cache entries stored since process start",
  registers: [registry],
});
const cacheErrors = new Gauge({
  name: "ethproxy_cache_errors_total",
  help: "Cache backend errors since process start",
  registers: [registry],
});

const localResponses = new Gauge({
  name: "ethproxy_local_responses_total",
  help: "Responses served from local data without an upstream call, by kind (cacheHit, blockNumber, filters)",
  labelNames: ["kind"],
  registers: [registry],
});

let bound: { pool: UpstreamPool; proxy: ProxyHandler } | null = null;

/** Point the dynamic gauges at the running pool/proxy (called by buildServer). */
export function bindMetrics(pool: UpstreamPool, proxy: ProxyHandler): void {
  bound = { pool, proxy };
}

function refreshGauges(): void {
  if (!bound) return;
  const status = bound.pool.status();
  chainHead.set(status.chainHead ?? 0);
  for (const u of status.upstreams) {
    upstreamHealthy.set(
      { upstream: u.name },
      u.healthy && !u.syncing ? 1 : 0,
    );
    upstreamWsHealthy.set({ upstream: u.name }, u.wsHealthy === true ? 1 : 0);
    upstreamBlockNumber.set({ upstream: u.name }, u.blockNumber ?? 0);
    upstreamLatency.set({ upstream: u.name }, u.latencyMs ?? 0);
  }
  const stats = bound.proxy.cacheStats();
  cacheHits.set(stats.hits);
  cacheMisses.set(stats.misses);
  cacheStores.set(stats.sets);
  cacheErrors.set(stats.errors);
  const local = bound.proxy.localStats();
  localResponses.set({ kind: "cacheHit" }, local.cacheHits);
  localResponses.set({ kind: "blockNumber" }, local.blockNumber);
  localResponses.set({ kind: "filters" }, local.filters);
}

/** Render the Prometheus exposition text for scraping. */
export async function renderMetrics(): Promise<string> {
  refreshGauges();
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
