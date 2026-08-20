import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";
import { handleWsConnection } from "./ws-proxy.js";

export async function buildServer(
  proxy: ProxyHandler,
  pool: UpstreamPool,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Must be awaited: the plugin's onRoute hook only wraps routes registered
  // after the plugin has loaded.
  await app.register(websocket);

  app.post("/", async (request, reply) => {
    const result = await proxy.handle(request.body);
    void reply.header("content-type", "application/json");
    return result;
  });

  // WebSocket JSON-RPC: plain forwarding to one healthy upstream.
  app.get("/", { websocket: true }, (socket) => {
    handleWsConnection(socket, pool, app.log);
  });

  app.get("/healthz", async (_request, reply) => {
    if (pool.hasEligible()) {
      return { status: "ok" };
    }
    return reply.code(503).send({ status: "no healthy upstream" });
  });

  app.get("/status", async () => pool.status());

  return app;
}
