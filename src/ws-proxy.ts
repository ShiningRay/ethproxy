import WebSocket from "ws";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";
import {
  errorResponse,
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcRequest,
} from "./rpc.js";
import { upstreamWsUrl } from "./upstream.js";

export interface WsLogger {
  warn: (msg: string, ...args: unknown[]) => void;
}

/** Methods that carry subscription state and must stay on a pinned upstream. */
const SUBSCRIPTION_METHODS = new Set(["eth_subscribe", "eth_unsubscribe"]);

/**
 * One client WebSocket connection.
 *
 * - Regular JSON-RPC calls (eth_call, eth_blockNumber, …) are routed through
 *   the HTTP proxy pipeline: caching, weighted load balancing and retries
 *   apply exactly as for HTTP clients.
 * - eth_subscribe / eth_unsubscribe are forwarded over a dedicated upstream
 *   WS connection pinned to this client (subscription state lives on the
 *   node). Subscription ids are assigned by the upstream and passed through
 *   unchanged, so eth_subscription notifications can be relayed directly.
 * - If the pinned upstream connection dies, the client connection is closed;
 *   the client is expected to reconnect and re-subscribe.
 */
class WsClientSession {
  private subConn: WebSocket | null = null;
  /** Pending subscribe/unsubscribe calls: upstream request id -> client id. */
  private readonly pending = new Map<number, JsonRpcId>();
  /** Subscription ids issued by the upstream on subConn. */
  private readonly knownSubIds = new Set<string>();
  private nextUpstreamId = 1;

  constructor(
    private readonly client: WebSocket,
    private readonly pool: UpstreamPool,
    private readonly proxy: ProxyHandler,
    private readonly logger?: WsLogger,
  ) {
    client.on("message", (data) => void this.handleMessage(data));
    client.on("close", () => this.closeSubConn());
    client.on("error", () => this.closeSubConn());
  }

  private send(payload: unknown): void {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(payload));
    }
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.send(errorResponse(null, -32700, "Parse error"));
      return;
    }

    if (Array.isArray(parsed)) {
      // Split: subscription items keep their pinned path, the rest go
      // through the proxy pipeline as one batch.
      const subs: JsonRpcRequest[] = [];
      const regular: unknown[] = [];
      for (const item of parsed) {
        if (isJsonRpcRequest(item) && SUBSCRIPTION_METHODS.has(item.method)) {
          subs.push(item);
        } else {
          regular.push(item);
        }
      }
      for (const request of subs) this.forwardSubscription(request);
      if (regular.length > 0) {
        this.send(await this.proxy.handle(regular));
      }
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      this.send(errorResponse(null, -32600, "Invalid Request"));
      return;
    }
    if (SUBSCRIPTION_METHODS.has(parsed.method)) {
      this.forwardSubscription(parsed);
      return;
    }
    this.send(await this.proxy.handle(parsed));
  }

  /** Lazily open the pinned upstream WS connection for subscriptions. */
  private ensureSubConn(): WebSocket | null {
    if (this.subConn && this.subConn.readyState === WebSocket.OPEN) {
      return this.subConn;
    }
    if (this.subConn && this.subConn.readyState === WebSocket.CONNECTING) {
      return this.subConn;
    }

    const upstream = this.pool.selectWs(1)[0];
    if (!upstream) return null;

    const conn = new WebSocket(upstreamWsUrl(upstream));
    conn.on("message", (data) => this.onUpstreamMessage(data));
    conn.on("close", () => {
      this.subConn = null;
      this.client.close(1011, "upstream subscription connection closed");
    });
    conn.on("error", (err) => {
      this.logger?.warn(`subscription upstream ${upstream.name} error`, err.message);
    });
    this.subConn = conn;
    return conn;
  }

  private forwardSubscription(request: JsonRpcRequest): void {
    const conn = this.ensureSubConn();
    if (!conn) {
      this.send(errorResponse(request.id, -32002, "no websocket-capable upstream"));
      return;
    }
    const upstreamId = this.nextUpstreamId++;
    this.pending.set(upstreamId, request.id);
    const forward = (): void =>
      conn.send(JSON.stringify({ ...request, id: upstreamId }));
    if (conn.readyState === WebSocket.OPEN) {
      forward();
    } else {
      conn.once("open", forward);
    }
  }

  private onUpstreamMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    // Response to a pending subscribe/unsubscribe call: restore client id.
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const clientId = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (typeof msg.result === "string") {
        // eth_subscribe result: the upstream-assigned subscription id.
        this.knownSubIds.add(msg.result);
      }
      if (msg.result === true) {
        // eth_unsubscribe succeeded; no further notifications expected.
      }
      this.send({ ...msg, id: clientId });
      return;
    }

    // Subscription notification: relay only for subscriptions this client owns.
    if (msg.method === "eth_subscription") {
      const params = msg.params as { subscription?: string } | undefined;
      if (params?.subscription !== undefined && this.knownSubIds.has(params.subscription)) {
        this.send(msg);
      }
    }
  }

  private closeSubConn(): void {
    this.subConn?.close();
    this.subConn = null;
  }
}

export function handleWsConnection(
  clientSocket: WebSocket,
  pool: UpstreamPool,
  proxy: ProxyHandler,
  logger?: WsLogger,
): void {
  new WsClientSession(clientSocket, pool, proxy, logger);
}
