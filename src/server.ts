import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { basicAuthHook } from "./auth.js";
import type { Config } from "./config.js";
import { renderIndexPage } from "./index-page.js";
import { bindMetrics, metricsContentType, renderMetrics, upstreamRequestCounts } from "./metrics.js";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";
import { RateLimiter, payloadCost, type BatchCostMode } from "./ratelimit.js";
import { errorResponse } from "./rpc.js";
import { handleWsConnection, SubscriptionRegistry } from "./ws-proxy.js";

export async function buildServer(
  proxy: ProxyHandler,
  pool: UpstreamPool,
  config: Config,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    // Per-request "incoming request"/"request completed" pairs carry no
    // useful detail (no RPC method, no outcome) — silence them; startup
    // and error logs are unaffected.
    disableRequestLogging: true,
    bodyLimit: config.security.maxBodyBytes,
    // We sit behind nginx/Cloudflare: trust X-Forwarded-For for client IPs
    // (rate limiting depends on it). Do not expose the port directly.
    trustProxy: true,
  });

  const httpLimiter = new RateLimiter(
    config.rateLimit.requestsPerSecond,
    config.rateLimit.burst,
  );
  const wsLimiter = new RateLimiter(
    config.rateLimit.wsMessagesPerSecond,
    config.rateLimit.wsBurst,
  );
  const batchCostMode = config.rateLimit.batchCost;
  const subscriptions = new SubscriptionRegistry();
  app.addHook("onClose", async () => {
    httpLimiter.close();
    wsLimiter.close();
  });

  // Must be awaited: the plugin's onRoute hook only wraps routes registered
  // after the plugin has loaded.
  await app.register(websocket);

  if (config.cors.enabled) {
    const origin = config.cors.origin.trim();
    await app.register(cors, {
      origin: origin === "*" ? "*" : origin.split(",").map((o) => o.trim()),
    });
  }

  if (config.auth.enabled) {
    if (!config.auth.username || !config.auth.password) {
      // loadConfig rejects this combination; Config objects built directly
      // (tests) bypass the schema, so fail fast instead of leaving auth off.
      throw new Error("auth.enabled requires auth.username and auth.password");
    }
    app.addHook("onRequest", basicAuthHook(config.auth));
  }

  app.post("/", async (request, reply) => {
    if (config.rateLimit.enabled) {
      const cost = payloadCost(request.body, batchCostMode);
      if (!httpLimiter.take(request.ip, cost)) {
        const retryAfterMs = httpLimiter.msUntilAvailable(request.ip, cost);
        return reply
          .code(429)
          // RFC 9110 Retry-After: delta-seconds. Lets a throttled client back
          // off deliberately instead of retrying blindly (which drains the
          // bucket further and keeps it throttled).
          .header("retry-after", Math.ceil(retryAfterMs / 1000))
          .header("content-type", "application/json")
          .send(errorResponse(null, -32005, "rate limit exceeded"));
      }
    }
    const result = await proxy.handle(request.body);
    void reply.header("content-type", "application/json");
    return result;
  });

  // WebSocket upgrades on / are forwarded to a healthy upstream. The HTML
  // landing page lives at config.statusPagePath ("/" by default; false
  // disables it). Plain GET / returns 404 when the page is moved or off.
  const pagePath = config.statusPagePath;
  const pageHtml = renderIndexPage({
    cacheBackend: config.cache.enabled ? config.cache.backend : "disabled",
  });

  app.route({
    method: "GET",
    url: "/",
    wsHandler: (socket, request) => {
      handleWsConnection(socket, pool, proxy, app.log, {
        limiter: config.rateLimit.enabled ? wsLimiter : undefined,
        clientIp: request.ip,
        batchCost: batchCostMode,
      }, subscriptions, config.rateLimit.maxSubscriptionsPerIp);
    },
    handler: async (_request, reply) => {
      if (pagePath === "/") {
        void reply.header("content-type", "text/html; charset=utf-8").send(pageHtml);
        return;
      }
      return reply.code(404).send({ error: "not found" });
    },
  });

  if (pagePath !== "/" && pagePath !== false) {
    app.get(pagePath, async (_request, reply) => {
      void reply.header("content-type", "text/html; charset=utf-8").send(pageHtml);
    });
  }

  app.get("/healthz", async (_request, reply) => {
    if (pool.hasEligible()) {
      return { status: "ok" };
    }
    return reply.code(503).send({ status: "no healthy upstream" });
  });

  app.get("/status", async () => {
    const status = pool.status();
    const counts = await upstreamRequestCounts();
    return {
      ...status,
      upstreams: status.upstreams.map((u) => ({
        ...u,
        requests: counts.get(u.name) ?? { ok: 0, error: 0 },
      })),
      cache: proxy.cacheStats(),
      local: proxy.localStats(),
      writes: proxy.writeStats(),
    };
  });

  bindMetrics(pool, proxy);
  app.get("/metrics", async (_request, reply) => {
    void reply.header("content-type", metricsContentType).send(await renderMetrics());
  });

  return app;
}
