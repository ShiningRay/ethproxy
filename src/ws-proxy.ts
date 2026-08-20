import WebSocket from "ws";
import type { UpstreamPool } from "./pool.js";
import type { Upstream } from "./upstream.js";

export interface WsLogger {
  warn: (msg: string, ...args: unknown[]) => void;
}

/** Derive the WS endpoint from an HTTP(S) URL when wsUrl is not configured. */
export function deriveWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function upstreamWsUrl(upstream: Upstream): string {
  return upstream.config.wsUrl ?? deriveWsUrl(upstream.config.url);
}

/**
 * Plain bidirectional WebSocket forwarding: each client connection is pinned
 * to one healthy upstream (chosen with the pool's weighted selection) and all
 * frames are relayed as-is. No caching, no subscription tracking — if the
 * upstream connection dies, the client connection is closed and the client
 * is expected to reconnect (it will then land on a healthy upstream).
 */
export function handleWsConnection(
  clientSocket: WebSocket,
  pool: UpstreamPool,
  logger?: WsLogger,
): void {
  const upstream = pool.select(1)[0];
  if (!upstream) {
    clientSocket.close(1011, "no healthy upstream");
    return;
  }

  const upstreamSocket = new WebSocket(upstreamWsUrl(upstream));
  /** Client frames received before the upstream connection is open. */
  const pending: { data: WebSocket.RawData; binary: boolean }[] = [];

  upstreamSocket.on("open", () => {
    for (const frame of pending) {
      upstreamSocket.send(frame.data, { binary: frame.binary });
    }
    pending.length = 0;
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });

  clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
    } else if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pending.push({ data, binary: isBinary });
    }
    // CLOSING/CLOSED: drop the frame; the close handlers will end the client side.
  });

  upstreamSocket.on("close", (code, reason) => {
    if (
      clientSocket.readyState === WebSocket.OPEN ||
      clientSocket.readyState === WebSocket.CONNECTING
    ) {
      clientSocket.close(code === 1006 ? 1011 : code, reason);
    }
  });

  clientSocket.on("close", () => {
    upstreamSocket.close();
  });

  upstreamSocket.on("error", (err) => {
    logger?.warn(`upstream ws error from ${upstream.name}`, err.message);
    clientSocket.close(1011, "upstream ws error");
  });

  clientSocket.on("error", () => {
    upstreamSocket.close();
  });
}
