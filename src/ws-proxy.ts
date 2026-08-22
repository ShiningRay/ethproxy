import WebSocket from "ws";
import type { UpstreamPool } from "./pool.js";
import type { ProxyHandler } from "./proxy.js";
import type { RateLimiter } from "./ratelimit.js";
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

export interface WsRateLimit {
  limiter: RateLimiter | undefined;
  clientIp: string;
}

/** Tracks live subscription ids per client IP across all connections. */
export class SubscriptionRegistry {
  private readonly byIp = new Map<string, Set<string>>();

  count(ip: string): number {
    return this.byIp.get(ip)?.size ?? 0;
  }

  add(ip: string, subId: string): void {
    let set = this.byIp.get(ip);
    if (!set) {
      set = new Set();
      this.byIp.set(ip, set);
    }
    set.add(subId);
  }

  remove(ip: string, subId: string): void {
    const set = this.byIp.get(ip);
    if (!set) return;
    set.delete(subId);
    if (set.size === 0) this.byIp.delete(ip);
  }

  removeAll(ip: string, subIds: Iterable<string>): void {
    for (const id of subIds) this.remove(ip, id);
  }
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
  /** Pending subscribe/unsubscribe calls: upstream request id -> call info. */
  private readonly pending = new Map<
    number,
    { clientId: JsonRpcId; method: string; subId?: string }
  >();
  /** Subscription ids issued by the upstream on subConn. */
  private readonly knownSubIds = new Set<string>();
  private nextUpstreamId = 1;

  constructor(
    private readonly client: WebSocket,
    private readonly pool: UpstreamPool,
    private readonly proxy: ProxyHandler,
    private readonly logger?: WsLogger,
    private readonly rateLimit?: WsRateLimit,
    private readonly subscriptions?: SubscriptionRegistry,
    private readonly maxSubscriptionsPerIp?: number,
  ) {
    client.on("message", (data) => void this.handleMessage(data));
    client.on("close", () => this.cleanup());
    client.on("error", () => this.cleanup());
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

    // Rate limit per client IP; each JSON-RPC call in the message costs 1.
    const cost = Array.isArray(parsed) ? parsed.length : 1;
    if (this.rateLimit?.limiter !== undefined) {
      if (!this.rateLimit.limiter.take(this.rateLimit.clientIp, cost)) {
        const id = !Array.isArray(parsed) && isJsonRpcRequest(parsed) ? parsed.id : null;
        this.send(errorResponse(id, -32005, "rate limit exceeded"));
        return;
      }
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
    // Enforce the per-IP subscription cap before pinning upstream resources.
    if (
      request.method === "eth_subscribe" &&
      this.subscriptions !== undefined &&
      this.maxSubscriptionsPerIp !== undefined &&
      this.rateLimit !== undefined &&
      this.subscriptions.count(this.rateLimit.clientIp) >= this.maxSubscriptionsPerIp
    ) {
      this.send(errorResponse(request.id, -32005, "subscription limit exceeded"));
      return;
    }

    const conn = this.ensureSubConn();
    if (!conn) {
      this.send(errorResponse(request.id, -32002, "no websocket-capable upstream"));
      return;
    }
    const upstreamId = this.nextUpstreamId++;
    const subId =
      request.method === "eth_unsubscribe" &&
      Array.isArray(request.params) &&
      typeof request.params[0] === "string"
        ? request.params[0]
        : undefined;
    this.pending.set(upstreamId, {
      clientId: request.id,
      method: request.method,
      subId,
    });
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
      const call = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (call.method === "eth_subscribe" && typeof msg.result === "string") {
        // eth_subscribe result: the upstream-assigned subscription id.
        this.knownSubIds.add(msg.result);
        if (this.rateLimit !== undefined) {
          this.subscriptions?.add(this.rateLimit.clientIp, msg.result);
        }
      }
      if (
        call.method === "eth_unsubscribe" &&
        msg.result === true &&
        call.subId !== undefined
      ) {
        this.knownSubIds.delete(call.subId);
        if (this.rateLimit !== undefined) {
          this.subscriptions?.remove(this.rateLimit.clientIp, call.subId);
        }
      }
      this.send({ ...msg, id: call.clientId });
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

  private cleanup(): void {
    if (this.rateLimit !== undefined) {
      this.subscriptions?.removeAll(this.rateLimit.clientIp, this.knownSubIds);
    }
    this.knownSubIds.clear();
    this.subConn?.close();
    this.subConn = null;
  }
}

export function handleWsConnection(
  clientSocket: WebSocket,
  pool: UpstreamPool,
  proxy: ProxyHandler,
  logger?: WsLogger,
  rateLimit?: WsRateLimit,
  subscriptions?: SubscriptionRegistry,
  maxSubscriptionsPerIp?: number,
): void {
  new WsClientSession(
    clientSocket,
    pool,
    proxy,
    logger,
    rateLimit,
    subscriptions,
    maxSubscriptionsPerIp,
  );
}
