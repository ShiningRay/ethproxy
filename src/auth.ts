import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig } from "./config.js";

/** Both sides are hashed so timingSafeEqual never sees a length difference. */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * onRequest hook enforcing HTTP Basic Auth on every route, including
 * WebSocket upgrades (upgrade requests run through the Fastify lifecycle, so
 * the 401 here prevents the handshake). CORS preflight is unaffected: the
 * plugin's own onRequest hook is registered first and answers OPTIONS before
 * this runs. When auth is enabled, config validation guarantees username and
 * password are set.
 */
export function basicAuthHook(auth: AuthConfig) {
  const exempt = new Set(auth.exemptPaths);
  const challenge = `Basic realm="${auth.realm}", charset="UTF-8"`;
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.url.indexOf("?");
    const path = query === -1 ? request.url : request.url.slice(0, query);
    if (exempt.has(path)) {
      return;
    }
    let ok = false;
    const header = request.headers.authorization;
    const match = header !== undefined ? /^Basic\s+(\S+)$/i.exec(header.trim()) : null;
    const encoded = match?.[1];
    if (encoded !== undefined) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        ok =
          safeEqual(decoded.slice(0, sep), auth.username as string) &&
          safeEqual(decoded.slice(sep + 1), auth.password as string);
      }
    }
    if (!ok) {
      void reply.code(401).header("www-authenticate", challenge);
      return reply.send({ error: "unauthorized" });
    }
  };
}
