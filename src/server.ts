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
    wsHandler: (socket) => {
      handleWsConnection(socket, pool, proxy, app.log);
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

  app.get("/status", async () => ({
    ...pool.status(),
    cache: proxy.cacheStats(),
  }));

  return app;
}
