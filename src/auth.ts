import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig } from "./config.js";

/** Both sides are hashed so timingSafeEqual never sees a length difference. */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Matches a presented token against every configured one without short-circuiting. */
function tokenMatches(presented: string, tokens: readonly string[]): boolean {
  let ok = false;
  for (const token of tokens) {
    // |= keeps the loop length independent of where (or whether) it matched.
    ok = safeEqual(presented, token) || ok;
  }
  return ok;
}

/**
 * onRequest hook enforcing auth on every route, including WebSocket
 * upgrades (upgrade requests run through the Fastify lifecycle, so the 401
 * here prevents the handshake). CORS preflight is unaffected: the plugin's
 * own onRequest hook is registered first and answers OPTIONS before this
 * runs. A request passes when it carries valid Basic credentials or a valid
 * token; when auth is enabled, config validation guarantees at least one
 * method is configured.
 */
export function authHook(auth: AuthConfig) {
  const exempt = new Set(auth.exemptPaths);
  const challenge = `Basic realm="${auth.realm}", charset="UTF-8"`;
  const hasBasic = auth.username !== undefined && auth.password !== undefined;
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.url.indexOf("?");
    const path = query === -1 ? request.url : request.url.slice(0, query);
    if (exempt.has(path)) {
      return;
    }
    const header = request.headers.authorization?.trim() ?? "";
    let ok = false;
    if (hasBasic) {
      const match = /^Basic\s+(\S+)$/i.exec(header);
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
    }
    if (!ok && auth.tokens.length > 0) {
      // Query string works for browser WebSocket handshakes, which cannot
      // send headers; the Bearer header is offered as a log-friendlier
      // alternative for plain HTTP clients.
      const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      const fromQuery =
        query === -1
          ? undefined
          : (new URLSearchParams(request.url.slice(query + 1)).get(auth.tokenParam) ?? undefined);
      const presented = bearer ?? fromQuery;
      if (presented !== undefined && presented !== "") {
        ok = tokenMatches(presented, auth.tokens);
      }
    }
    if (!ok) {
      void reply.code(401);
      // Only challenge with Basic when Basic is actually configured; a
      // Basic challenge with no credentials behind it pops a login box
      // that can never succeed.
      if (hasBasic) {
        void reply.header("www-authenticate", challenge);
      }
      return reply.send({ error: "unauthorized" });
    }
  };
}
