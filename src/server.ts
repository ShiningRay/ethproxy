import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { renderIndexPage } from "./index-page.js";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";
import { handleWsConnection } from "./ws-proxy.js";

export async function buildServer(
  proxy: ProxyHandler,
  pool: UpstreamPool,
  config: Config,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: config.security.maxBodyBytes,
  });

  // Must be awaited: the plugin's onRoute hook only wraps routes registered
  // after the plugin has loaded.
  await app.register(websocket);

  app.post("/", async (request, reply) => {
    const result = await proxy.handle(request.body);
    void reply.header("content-type", "application/json");
    return result;
  });

  // GET / serves the landing page for browsers; WebSocket upgrades on the
  // same path are forwarded to a healthy upstream.
  app.route({
    method: "GET",
    url: "/",
    wsHandler: (socket) => {
      handleWsConnection(socket, pool, app.log);
    },
    handler: async (_request, reply) => {
      void reply
        .header("content-type", "text/html; charset=utf-8")
        .send(renderIndexPage({ cacheBackend: config.cache.backend }));
    },
  });

  app.get("/healthz", async (_request, reply) => {
    if (pool.hasEligible()) {
      return { status: "ok" };
    }
    return reply.code(503).send({ status: "no healthy upstream" });
  });

  app.get("/status", async () => ({
    ...pool.status(),
    cache: proxy.cacheStats(),
  }));

  return app;
}
