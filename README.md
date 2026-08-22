# ethproxy

[中文文档](README.zh-CN.md)

A reverse proxy for Ethereum JSON-RPC: multi-upstream weighted load balancing with failover, sync-aware health checking, consistency-preserving `latest` handling, and tiered (nature-aware) response caching.

## Features

- **Multiple upstreams**: weighted round-robin; automatic failover to the next healthy node on transport errors (side-effecting methods like `eth_sendRawTransaction` are never retried)
- **Health & sync checks**: background polling of `eth_syncing` + `eth_blockNumber` + `eth_chainId`; nodes that are syncing, exceed the consecutive-failure threshold, or lag the pool head by more than `maxBlockLag` are removed and rejoin automatically once recovered
- **Chain consistency guard**: with `chainId` configured, upstreams reporting a different chain id are excluded outright (protects against misconfigured nodes on other chains); without it, the majority chain id is adopted as the reference
- **Tiered caching** (not blind caching):
  - Permanent: hash-addressed immutable data (blocks, transactions, mined receipts), queries at finalized depth (block ≤ head − `finalityDepth`), chain constants (`eth_chainId` etc., 1h TTL)
  - Short TTL (default 2s): head-dependent data such as `eth_gasPrice`
  - Never cached: write methods like `eth_sendRawTransaction`, `pending` tags, future blocks, admin namespaces (`admin_*`/`debug_*`/…), unrecognized methods (fail-safe)
- **`latest` consistency**: `latest` tags — including the implicit latest when the block param is omitted — are translated to the locally observed pool head H before caching/forwarding. All clients read the same height within a poll window and cache keys stay stable as `(method, H)`. Translated requests route only to nodes with `blockNumber >= H`; if none qualify, the original `latest` request is forwarded without caching its response. `eth_blockNumber` is answered directly from the local head with zero upstream calls
- **Pluggable cache backends**: in-memory LRU (default) or Redis; implement the `CacheBackend` interface to add your own
- **Batch requests**: each element goes through the cache pipeline individually; misses are split by cacheability (cacheable items via single-flight, the rest merged into one upstream batch)
- **Single-flight**: concurrent misses for the same cache key share one upstream request, preventing the thundering herd when short-TTL entries expire
- **Public-RPC hardening**: `admin_*`/`debug_*`/`personal_*`-style namespaces are rejected by default; batch size, request body size and `eth_getLogs` block span are limited
- **WebSocket split handling**: regular JSON-RPC over WS goes through the same proxy pipeline as HTTP (caching, load balancing, retries); `eth_subscribe`/`eth_unsubscribe` pass through over a per-client pinned upstream WS connection, with notifications relayed back as-is; if the pinned connection dies the client connection is closed (clients should reconnect and re-subscribe)
- **Ops endpoints**: `GET /` landing page (live chain height, per-upstream health/WS/latency), `GET /healthz` (503 when no healthy upstream), `GET /status` (JSON status incl. cache hit/miss stats), `GET /metrics` (Prometheus: per-method request counts & duration histograms, upstream health/height/latency, cache stats)

## Quick start

```bash
npm install
cp config.example.yaml config.yaml   # edit upstreams to match your nodes
npm run dev -- config.yaml           # development
# or
npm run build && npm start -- config.yaml
```

Point your clients at `http://127.0.0.1:8545`.

## Docker

```bash
docker build -t ethproxy .
docker run -p 8545:8545 -v "$PWD/config.yaml:/app/config.yaml:ro" ethproxy
```

The config file is injected via mount; a custom path can be passed: `docker run ... ethproxy /etc/ethproxy/prod.yaml`.

## Configuration

See [config.example.yaml](config.example.yaml). Key options:

| Option | Description | Default |
|---|---|---|
| `upstreams[].url` / `weight` / `wsUrl` | Upstream HTTP endpoint, weight, and WS endpoint (derived from `url` when unset) | — |
| `statusPagePath` | Path of the HTML status page; `false` disables the page entirely (`/status` JSON is unaffected) | `/` |
| `chainId` | Expected chain id (e.g. 1 = mainnet); majority wins when unset | auto-detect |
| `health.pollIntervalMs` | Health poll interval | 5000 |
| `health.maxBlockLag` | Blocks behind the pool head before a node is removed | 5 |
| `health.failureThreshold` | Consecutive failures before removal | 3 |
| `health.maxRetries` | Upstreams tried per request | 2 |
| `health.retryBaseDelayMs` / `retryMaxDelayMs` | Exponential retry backoff: `base * 2^(n-1)`, capped at max | 100 / 1000 |
| `cache.backend` | `memory` or `redis` | `memory` |
| `cache.enabled` | Master switch; when `false` every request bypasses the cache (and Redis is never connected) | true |
| `cache.shortTtlMs` | TTL for head-dependent data (ceiling/fallback when dynamicTtl is on) | 2000 |
| `cache.dynamicTtl` | Derive short TTL from the observed block interval (interval/4, clamped to `[minTtlMs, shortTtlMs]`) | true |
| `cache.finalityDepth` | Depth below which blocks are treated as immutable | 64 |
| `cache.redis.url` / `keyPrefix` | Redis connection and key prefix | — |
| `security.blockedNamespaces` | RPC namespaces rejected outright | admin, personal, debug, trace, miner, txpool |
| `security.maxBatchSize` / `maxBodyBytes` / `maxLogsRange` | Batch element limit, body size limit, `eth_getLogs` span limit | 100 / 1MB / 10000 |
| `rateLimit.enabled` | Per-client-IP rate limiting (HTTP 429 / WS error -32005) | true |
| `rateLimit.requestsPerSecond` / `burst` | HTTP rate and burst (batches cost their element count) | 50 / 100 |
| `rateLimit.wsMessagesPerSecond` / `wsBurst` | WS message rate and burst | 20 / 40 |
| `rateLimit.maxSubscriptionsPerIp` | Max concurrent subscriptions per IP (across connections; freed on unsubscribe/disconnect) | 20 |

## Caching details

The decision logic lives in [`src/cache-rules.ts`](src/cache-rules.ts): `requestPolicy(method, params, ctx)` decides cacheability at request time, and `responseTtl()` refines it based on the response (e.g. `eth_getTransactionReceipt` is cached permanently only when it carries a `blockHash`; a `null` result gets a very short TTL). Cache keys are `method + sha256(normalized params)`.

## Extending cache backends

Implement the interface from `src/cache/types.ts` and register it in the factory in `src/cache/index.ts`:

```ts
interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number | null): Promise<void>; // null = no expiry
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
```

Backend failures degrade gracefully to cache misses; proxying is never blocked by the cache.

## Deploying behind Cloudflare (DDoS mitigation)

ethproxy itself covers the application layer (method blocklist, request shape limits, cache absorption, single-flight). Full protection should be layered, with Cloudflare and infrastructure taking the outer layers:

**Cloudflare (highest payoff, do first):**

- L3/L4 volumetric attacks (SYN floods, UDP amplification) are absorbed by CF's proxied mode, invisible to the origin
- Enable managed WAF rules, Rate Limiting (e.g. N requests/s per IP), Bot Fight Mode
- **Origin lockdown**: allow ports 80/443 only from [Cloudflare's official IP ranges](https://www.cloudflare.com/ips/) in your security group/firewall, so attackers cannot bypass CF and hit the origin directly — without this, CF protection is moot
- Prefer SSL mode Full (Strict) + a Cloudflare Origin Certificate

**nginx / gateway:**

- `limit_req_zone` per-IP rate limiting, `limit_conn` connection caps
- WebSocket upgrade header mapping and long timeouts
- Forward the real client IP (`X-Forwarded-For` / CF's `CF-Connecting-IP`) for downstream rate limiting

**ethproxy (implemented):**

- Dangerous namespaces rejected by default (`debug_traceTransaction` alone can pin a node's CPU for seconds — a classic application-layer attack)
- Batch size, body size and `eth_getLogs` span limits
- Tiered caching + single-flight: hot read paths barely touch upstreams
- Health checking + failover: fail fast instead of piling up requests when upstreams degrade

**Reference topology** (this project's production setup):

```
clients → Cloudflare (WAF/rate limits/TLS) → nginx (WS upgrade/limits) → ethproxy (127.0.0.1:8545) → upstream nodes
```

## Development

```bash
npm test          # vitest (unit + integration, mocked upstreams)
npm run typecheck # tsc --noEmit
```

## Out of scope (for now)

- Automatic re-subscription for WebSocket subscriptions (when the pinned upstream connection dies the client connection is closed; clients own reconnect + re-subscribe)
- Authentication
