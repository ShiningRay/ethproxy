import { request } from "undici";
import type { UpstreamConfig, UpstreamCooldownConfig } from "./config.js";
import type { JsonRpcResponse } from "./rpc.js";

export interface UpstreamStatus {
  name: string;
  url: string;
  weight: number;
  healthy: boolean;
  syncing: boolean;
  blockNumber: number | null;
  chainId: number | null;
  /** null = not probed yet, true/false = last WS probe result. */
  wsHealthy: boolean | null;
  /** Rolling average RTT of the health-poll batch, ms; null before first poll. */
  latencyMs: number | null;
  consecutiveFailures: number;
  /** True while parked after a rate-limit response; requests skip it until it clears. */
  throttled: boolean;
  /** Epoch ms when the current cooldown ends; null when not throttled. */
  throttledUntil: number | null;
}

/** Derive the WS endpoint from an HTTP(S) URL when wsUrl is not configured. */
export function deriveWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export function upstreamWsUrl(upstream: Upstream): string {
  return upstream.config.wsUrl ?? deriveWsUrl(upstream.config.url);
}

/** Error thrown when the upstream is unreachable at the transport level. */
export class UpstreamTransportError extends Error {
  constructor(
    public readonly upstreamName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`upstream ${upstreamName}: ${message}`, options);
    this.name = "UpstreamTransportError";
  }
}

/**
 * Thrown when an upstream answers HTTP 429 — a rate-limit signal. The
 * upstream has been parked (see Upstream.markThrottled); callers treat this
 * like a transport error and fail over to another upstream.
 */
export class UpstreamThrottledError extends UpstreamTransportError {
  constructor(
    upstreamName: string,
    public readonly retryAfterMs: number | null,
    message = "rate limited (HTTP 429)",
  ) {
    super(upstreamName, message);
    this.name = "UpstreamThrottledError";
  }
}

/** JSON-RPC error messages that indicate an upstream rate-limit rejection. */
const RATE_LIMIT_HINTS = [
  /rate ?limit/i,
  /too many requests/i,
  /frequency limit/i,
  /usage limit/i,
  /quota (exceeded|exhausted)/i,
];

/** True when a JSON-RPC error message looks like a rate-limit rejection. */
export function isRateLimitMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    RATE_LIMIT_HINTS.some((re) => re.test(message))
  );
}

/**
 * True when `method` matches a configured pattern. A pattern is either an
 * exact method name or a namespace glob ending in "*", which matches any
 * method starting with the prefix ("debug_*" matches "debug_traceCall").
 */
export function methodMatchesPattern(
  method: string,
  pattern: string,
): boolean {
  if (pattern.endsWith("*")) {
    return method.startsWith(pattern.slice(0, -1));
  }
  return method === pattern;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms from now. */
export function parseRetryAfter(
  header: unknown,
  now = Date.now(),
): number | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Token bucket used to pace requests against one upstream. Time-based
 * refill; `now` is injectable so tests can advance time without waiting.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    readonly refillPerSecond: number,
    readonly capacity: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  private refill(now: number): void {
    if (now <= this.updatedAt) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) / 1000) * this.refillPerSecond,
    );
    this.updatedAt = now;
  }

  /** True when a token can be taken right now (does not consume one). */
  ready(now = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  /** Consume one token when available. */
  take(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until at least one token is available; 0 when ready now. */
  msUntilReady(now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }
}

/** Default cooldown policy when config.upstreamCooldown is absent. */
export const DEFAULT_UPSTREAM_COOLDOWN: UpstreamCooldownConfig = {
  defaultMs: 15000,
  maxMs: 300000,
};

export interface UpstreamLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Upstream {
  healthy = false;
  syncing = false;
  blockNumber: number | null = null;
  chainId: number | null = null;
  wsHealthy: boolean | null = null;
  consecutiveFailures = 0;
  /** Recent poll round-trip times, ms (rolling window). */
  private latencySamples: number[] = [];
  /** Pacing bucket from config.rateLimit; null = unlimited. */
  private readonly bucket: TokenBucket | null;
  /** Epoch ms until which the upstream is parked after a rate-limit response; 0 = not parked. */
  private throttledUntil = 0;

  constructor(
    public readonly config: UpstreamConfig,
    private readonly timeoutMs: number,
    private readonly cooldown: UpstreamCooldownConfig = DEFAULT_UPSTREAM_COOLDOWN,
    private readonly logger?: UpstreamLogger,
  ) {
    const rl = config.rateLimit;
    this.bucket =
      rl === undefined
        ? null
        : new TokenBucket(
            rl.requestsPerSecond,
            rl.burst ?? Math.max(1, Math.ceil(rl.requestsPerSecond)),
          );
  }

  get name(): string {
    return this.config.name;
  }

  /** Record one health-poll round-trip time. */
  recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > 5) this.latencySamples.shift();
  }

  /** Rolling average poll RTT in ms; null before the first successful poll. */
  get latencyMs(): number | null {
    if (this.latencySamples.length === 0) return null;
    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.latencySamples.length);
  }

  // ---- request pacing (config.rateLimit) ----

  /** True when the pacing bucket allows a request now; unlimited upstreams are always ready. */
  tokenReady(now = Date.now()): boolean {
    return this.bucket === null || this.bucket.ready(now);
  }

  /** Try to consume one pacing token (non-blocking); unlimited upstreams always succeed. */
  takeToken(now = Date.now()): boolean {
    return this.bucket === null || this.bucket.take(now);
  }

  /** Milliseconds until the next pacing token; 0 when ready or unlimited. */
  msUntilToken(now = Date.now()): number {
    return this.bucket === null ? 0 : this.bucket.msUntilReady(now);
  }

  // ---- method whitelist / blacklist (config.methods) ----

  /**
   * True when this upstream may serve the given set of methods (one
   * JSON-RPC call, or every item of a batch). `deny` wins over `allow`;
   * with neither configured everything is allowed.
   */
  canServeMethods(methods: readonly string[]): boolean {
    const m = this.config.methods;
    if (m === undefined) return true;
    if (m.deny !== undefined && m.deny.length > 0) {
      for (const method of methods) {
        if (m.deny.some((p) => methodMatchesPattern(method, p))) return false;
      }
    }
    if (m.allow !== undefined && m.allow.length > 0) {
      for (const method of methods) {
        if (!m.allow.some((p) => methodMatchesPattern(method, p))) return false;
      }
    }
    return true;
  }

  /**
   * Wait until a token can be taken, consuming it atomically. Returns false
   * when the wait would exceed maxWaitMs (nothing is consumed then).
   */
  async waitAndTakeToken(maxWaitMs: number): Promise<boolean> {
    if (this.bucket === null) return true;
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    for (;;) {
      const now = Date.now();
      if (this.bucket.take(now)) return true;
      const remaining = deadline - now;
      if (remaining <= 0) return false;
      await sleep(Math.min(this.bucket.msUntilReady(now) + 5, remaining));
    }
  }

  // ---- rate-limit cooldown (reactive) ----

  /**
   * Park the upstream until a rate-limit cooldown elapses (never shortens an
   * active one). Returns the remaining cooldown in ms.
   */
  markThrottled(cooldownMs: number, now = Date.now()): number {
    const until = now + Math.max(0, cooldownMs);
    const extended = until > this.throttledUntil;
    if (extended) {
      this.throttledUntil = until;
      this.logger?.warn(
        `upstream ${this.name} answered with a rate-limit; parked for ${Math.round((until - now) / 1000)}s`,
      );
    }
    return Math.max(0, this.throttledUntil - now);
  }

  /** True while the upstream is parked after a rate-limit response. */
  isThrottled(now = Date.now()): boolean {
    return this.throttledUntil > now;
  }

  /**
   * Resolve the cooldown for a rate-limit response: per-upstream config
   * wins, then the Retry-After header, then the global default; always
   * capped at the configured max.
   */
  private resolveCooldownMs(retryAfterMs: number | null): number {
    const base =
      this.config.cooldownMs ?? retryAfterMs ?? this.cooldown.defaultMs;
    return Math.min(base, this.cooldown.maxMs);
  }

  /** Park the upstream when any JSON-RPC error in the response is a rate-limit rejection. */
  private noteRateLimitErrors(body: JsonRpcResponse | JsonRpcResponse[]): void {
    const list = Array.isArray(body) ? body : [body];
    for (const r of list) {
      if (isRateLimitMessage(r.error?.message)) {
        this.markThrottled(this.resolveCooldownMs(null));
        return;
      }
    }
  }

  /**
   * Forward a raw JSON-RPC payload (single object or batch array) and return
   * the parsed response body. Throws UpstreamTransportError on network
   * errors, timeouts and non-2xx HTTP statuses; HTTP 429 additionally parks
   * the upstream and throws UpstreamThrottledError. Rate-limit JSON-RPC
   * errors inside a 200 response park the upstream and are returned as-is.
   */
  async call(
    payload: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    let res;
    try {
      res = await request(this.config.url, {
        method: "POST",
        // Upstream-configured headers may override the default content type.
        headers: { "content-type": "application/json", ...this.config.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UpstreamTransportError(this.name, "request failed", {
        cause: err,
      });
    }

    if (res.statusCode === 429) {
      const retryAfterMs = parseRetryAfter(res.headers["retry-after"]);
      await res.body.dump();
      this.markThrottled(this.resolveCooldownMs(retryAfterMs));
      throw new UpstreamThrottledError(this.name, retryAfterMs);
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new UpstreamTransportError(
        this.name,
        `HTTP ${res.statusCode}`,
      );
    }

    let parsed: JsonRpcResponse | JsonRpcResponse[];
    try {
      parsed = (await res.body.json()) as JsonRpcResponse | JsonRpcResponse[];
    } catch (err) {
      throw new UpstreamTransportError(this.name, "invalid JSON body", {
        cause: err,
      });
    }
    this.noteRateLimitErrors(parsed);
    return parsed;
  }

  status(): UpstreamStatus {
    const now = Date.now();
    const throttled = this.isThrottled(now);
    return {
      name: this.name,
      url: this.config.url,
      weight: this.config.weight,
      healthy: this.healthy,
      syncing: this.syncing,
      blockNumber: this.blockNumber,
      chainId: this.chainId,
      wsHealthy: this.wsHealthy,
      latencyMs: this.latencyMs,
      consecutiveFailures: this.consecutiveFailures,
      throttled,
      throttledUntil: throttled ? this.throttledUntil : null,
    };
  }
}
