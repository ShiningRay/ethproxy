import Fastify, { type FastifyInstance } from "fastify";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";

export function buildServer(
  proxy: ProxyHandler,
  pool: UpstreamPool,
): FastifyInstance {
  const app = Fastify({ logger: true });

  app.post("/", async (request, reply) => {
    const result = await proxy.handle(request.body);
    void reply.header("content-type", "application/json");
    return result;
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
