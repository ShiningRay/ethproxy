interface Bucket {
  tokens: number;
  updatedAt: number;
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

  private sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 600_000) this.buckets.delete(key);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
