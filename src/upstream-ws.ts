import WebSocket from "ws";
import { upstreamWsUrl, type Upstream } from "./upstream.js";

export interface UpstreamWsCallbacks {
  /** newHeads notification payload (head object). */
  onHead?: (head: Record<string, unknown>) => void;
  /** newPendingTransactions notification payload (transaction hash). */
  onPendingTx?: (hash: string) => void;
  /** syncing notification payload: false when not syncing, progress object otherwise. */
  onSyncing?: (status: false | Record<string, unknown>) => void;
  /** Called on WS availability transitions (subscription confirmed / lost). */
  onAvailability: (available: boolean, detail?: string) => void;
}

/** Which subscriptions to hold on the persistent connection. */
export interface UpstreamWsSubscriptions {
  newHeads: boolean;
  pendingTransactions: boolean;
  syncing: boolean;
}

type SubKind = "newHeads" | "newPendingTransactions" | "syncing";

/**
 * Maintains one persistent WS connection to an upstream carrying the
 * configured eth_subscribe feeds (newHeads and/or newPendingTransactions).
 * Notifications drive the pool's locally observed chain state; when the
 * socket is unavailable or drops, the HTTP health poll remains the fallback
 * (automatic).
 *
 * ensureStarted() is idempotent and resolves once the subscription attempt
 * reaches a definite state; reconnects happen with exponential backoff, and
 * the poll cycle re-invokes ensureStarted() as a backstop.
 */
export class UpstreamWsConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** In-flight connect attempt; null when disconnected and idle. */
  private ready: Promise<void> | null = null;

  constructor(
    private readonly upstream: Upstream,
    private readonly subscriptions: UpstreamWsSubscriptions,
    private readonly callbacks: UpstreamWsCallbacks,
    private readonly timeoutMs: number,
    /**
     * Client-side keepalive: send a WS ping every this many ms, and treat
     * the connection as dead (terminate + reconnect) when no pong arrives
     * for two intervals. Many providers' gateways idle-drop silent
     * connections (close code 1006); the ping keeps them alive, and the
     * watchdog detects half-open sockets that never emit a close frame.
     */
    private readonly pingIntervalMs: number = 30000,
  ) {}

  /** Connect unless a socket is already live or connecting. */
  ensureStarted(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ws !== null) return this.ready ?? Promise.resolve();
    this.ready = this.connect();
    return this.ready;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.terminate();
    this.ws = null;
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(upstreamWsUrl(this.upstream));
      this.ws = ws;
      /**
       * Set when WE initiate the teardown (connect timeout, ping watchdog),
       * so the close log can tell local teardowns apart from peer-initiated
       * closes — both would otherwise surface as the same 1006.
       */
      let teardownReason: string | null = null;
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        teardownReason = `connect/subscribe timeout after ${this.timeoutMs}ms`;
        ws.terminate();
      }, this.timeoutMs);

      const kinds: SubKind[] = [];
      if (this.subscriptions.newHeads) kinds.push("newHeads");
      if (this.subscriptions.pendingTransactions) kinds.push("newPendingTransactions");
      if (this.subscriptions.syncing) kinds.push("syncing");

      /** request id -> kind, until the subscription is confirmed/rejected. */
      const pendingByReqId = new Map<number, SubKind>();
      /** subscription id -> kind, for routing notifications. */
      const kindBySubId = new Map<string, SubKind>();
      let answered = 0;
      let confirmed = 0;

      // Keepalive state for this connection's lifetime.
      let lastPongAt = 0;
      let pingTimer: NodeJS.Timeout | null = null;
      const stopPing = (): void => {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      };

      ws.on("open", () => {
        kinds.forEach((kind, i) => {
          pendingByReqId.set(i + 1, kind);
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: i + 1,
              method: "eth_subscribe",
              params: [kind],
            }),
          );
        });
        if (this.pingIntervalMs > 0) {
          lastPongAt = Date.now();
          pingTimer = setInterval(() => {
            if (Date.now() - lastPongAt > 2 * this.pingIntervalMs) {
              // Half-open or dead connection: force teardown + reconnect.
              teardownReason = `no pong for >${2 * this.pingIntervalMs}ms (local watchdog)`;
              ws.terminate();
              return;
            }
            ws.ping();
          }, this.pingIntervalMs);
          pingTimer.unref();
        }
      });
      ws.on("pong", () => {
        lastPongAt = Date.now();
      });

      ws.on("message", (data) => {
        let msg: {
          id?: unknown;
          result?: unknown;
          method?: unknown;
          params?: { subscription?: unknown; result?: unknown };
        };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (typeof msg.id === "number" && pendingByReqId.has(msg.id)) {
          const kind = pendingByReqId.get(msg.id)!;
          pendingByReqId.delete(msg.id);
          answered += 1;
          if (typeof msg.result === "string") {
            kindBySubId.set(msg.result, kind);
            confirmed += 1;
            if (confirmed === 1) {
              this.attempts = 0;
              this.callbacks.onAvailability(true);
            }
          }
          // A node rejecting one feed (e.g. no newPendingTransactions
          // support) must not kill the others; only give up when every
          // subscription was rejected.
          if (answered === kinds.length) {
            if (confirmed === 0) ws.close();
            finish();
          }
          return;
        }

        if (msg.method === "eth_subscription") {
          const subId = msg.params?.subscription;
          const kind =
            typeof subId === "string" ? kindBySubId.get(subId) : undefined;
          if (
            kind === "newHeads" &&
            typeof msg.params?.result === "object" &&
            msg.params.result !== null
          ) {
            this.callbacks.onHead?.(msg.params.result as Record<string, unknown>);
          } else if (
            kind === "newPendingTransactions" &&
            typeof msg.params?.result === "string"
          ) {
            this.callbacks.onPendingTx?.(msg.params.result);
          } else if (kind === "syncing") {
            const status = msg.params?.result;
            if (
              status === false ||
              (typeof status === "object" && status !== null)
            ) {
              this.callbacks.onSyncing?.(
                status as false | Record<string, unknown>,
              );
            }
          }
        }
      });

      const onDown = (code?: number, reason?: Buffer): void => {
        stopPing();
        if (this.ws === ws) {
          this.ws = null;
          this.ready = null;
        }
        // Surface WHY the socket went down: our own teardown (timeout /
        // watchdog) or the peer's close code/reason — a policy kick
        // (e.g. 1008), a clean close (1000) or an abnormal drop (1006).
        const detail =
          teardownReason ??
          (code === undefined
            ? undefined
            : `closed with ${code}${reason && reason.length > 0 ? `: ${reason.toString()}` : ""}`);
        this.callbacks.onAvailability(false, detail);
        finish();
        this.scheduleReconnect();
      };
      // "error" is always followed by "close"; handle the teardown once.
      ws.on("error", () => {});
      ws.on("close", (code, reason) => onDown(code, reason));
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delayMs = Math.min(30000, 1000 * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted();
    }, delayMs);
    this.reconnectTimer.unref();
  }
}
