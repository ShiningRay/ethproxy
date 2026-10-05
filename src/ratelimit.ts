interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** How a JSON-RPC batch is charged: per element, or per request. */
export type BatchCostMode = "items" | "request";

/**
 * Tokens to charge for one inbound payload.
 * - "items":   a batch costs one token per element, so a 100-item batch needs
 *              100 tokens and is rejected whole when the bucket is short
 *              (batches then compete with single requests for the budget).
 * - "request": any payload costs one token, however many calls it carries,
 *              so a client can pack many calls into a single token.
 * A non-batch payload always costs one. Empty batches still cost one, so an
 * empty array cannot be used to probe the endpoint for free.
 */
export function payloadCost(body: unknown, mode: BatchCostMode): number {
  if (!Array.isArray(body)) return 1;
  return mode === "request" ? 1 : Math.max(1, body.length);
}

/**
 * Per-key token bucket rate limiter. Keys are typically client IPs.
 * Idle buckets are swept periodically so the map does not grow forever.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60000);
    this.sweeper.unref();
  }

  /**
   * Try to spend `cost` tokens for `key`. Returns true when the request may
   * proceed. `now` is injectable for tests.
   */
  take(key: string, cost = 1, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSec * this.refillPerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Milliseconds until `cost` tokens are available for `key`. Used for the
   * Retry-After header so a throttled client knows how long to back off
   * instead of retrying blindly. Never waits for an existing bucket, so a
   * brand-new key reports 0 (its first request would be allowed).
   */
  msUntilAvailable(key: string, cost = 1, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSec * this.refillPerSecond,
    );
    if (tokens >= cost) return 0;
    // cost can exceed the capacity (e.g. a batch larger than the burst); cap
    // the wait at a full refill from empty so the value stays finite.
    const deficit = Math.max(0, Math.min(cost, this.capacity) - tokens);
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  private sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 600_000) this.buckets.delete(key);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
