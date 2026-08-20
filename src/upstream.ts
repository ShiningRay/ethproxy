import { request } from "undici";
import type { UpstreamConfig } from "./config.js";
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
  consecutiveFailures: number;
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

export class Upstream {
  healthy = false;
  syncing = false;
  blockNumber: number | null = null;
  chainId: number | null = null;
  wsHealthy: boolean | null = null;
  consecutiveFailures = 0;

  constructor(
    public readonly config: UpstreamConfig,
    private readonly timeoutMs: number,
  ) {}

  get name(): string {
    return this.config.name;
  }

  /**
   * Forward a raw JSON-RPC payload (single object or batch array) and return
   * the parsed response body. Throws UpstreamTransportError on network errors,
   * timeouts and non-2xx HTTP statuses.
   */
  async call(
    payload: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    let res;
    try {
      res = await request(this.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UpstreamTransportError(this.name, "request failed", {
        cause: err,
      });
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new UpstreamTransportError(
        this.name,
        `HTTP ${res.statusCode}`,
      );
    }

    try {
      return (await res.body.json()) as JsonRpcResponse | JsonRpcResponse[];
    } catch (err) {
      throw new UpstreamTransportError(this.name, "invalid JSON body", {
        cause: err,
      });
    }
  }

  status(): UpstreamStatus {
    return {
      name: this.name,
      url: this.config.url,
      weight: this.config.weight,
      healthy: this.healthy,
      syncing: this.syncing,
      blockNumber: this.blockNumber,
      chainId: this.chainId,
      wsHealthy: this.wsHealthy,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
