import { createCacheBackend, ResponseCache } from "./cache/index.js";
import { loadConfig } from "./config.js";
import { UpstreamPool } from "./pool.js";
import { ProxyHandler } from "./proxy.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config.yaml";
  const config = loadConfig(configPath);

  const pool = new UpstreamPool(
    config.upstreams,
    config.health,
    console,
    config.chainId,
  );
  pool.start();

  const cache = new ResponseCache(createCacheBackend(config.cache), console);
  const proxy = new ProxyHandler(pool, cache, config, console);
  const app = await buildServer(proxy, pool);

  const shutdown = async (): Promise<void> => {
    pool.stop();
    await app.close();
    await cache.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host: config.listen.host, port: config.listen.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
