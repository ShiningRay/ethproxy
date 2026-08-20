import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../src/pool.js";
import { computeShortTtlMs, retryDelayMs } from "../src/proxy.js";
import type { HealthConfig } from "../src/config.js";

const health: HealthConfig = {
  pollIntervalMs: 60000,
  requestTimeoutMs: 2000,
  maxBlockLag: 5,
  failureThreshold: 2,
  maxRetries: 2,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
};

describe("UpstreamPool block-time estimation", () => {
  it("returns null before any head progress is observed", () => {
    const pool = new UpstreamPool([], health);
    pool.observeHead(100, 1000);
    expect(pool.estimatedBlockIntervalMs).toBeNull();
    // same head again: still no progress
    pool.observeHead(100, 3000);
    expect(pool.estimatedBlockIntervalMs).toBeNull();
  });

  it("estimates the interval from observed head progress", () => {
    const pool = new UpstreamPool([], health);
    pool.observeHead(100, 0);
    pool.observeHead(101, 2000); // 1 block in 2s
    expect(pool.estimatedBlockIntervalMs).toBe(2000);
    pool.observeHead(104, 5000); // 3 blocks in 3s -> cumulative 5s / 4 blocks
    expect(pool.estimatedBlockIntervalMs).toBe(1250);
  });

  it("handles head regressions by re-basing without a sample", () => {
    const pool = new UpstreamPool([], health);
    pool.observeHead(100, 0);
    pool.observeHead(90, 1000); // regression: no sample, new base
    expect(pool.estimatedBlockIntervalMs).toBeNull();
    pool.observeHead(91, 3000);
    expect(pool.estimatedBlockIntervalMs).toBe(2000);
  });
});

describe("retryDelayMs", () => {
  const cfg = { retryBaseDelayMs: 100, retryMaxDelayMs: 1000 };

  it("doubles the delay per attempt", () => {
    expect(retryDelayMs(1, cfg)).toBe(100);
    expect(retryDelayMs(2, cfg)).toBe(200);
    expect(retryDelayMs(3, cfg)).toBe(400);
  });

  it("caps at retryMaxDelayMs", () => {
    expect(retryDelayMs(4, cfg)).toBe(800);
    expect(retryDelayMs(5, cfg)).toBe(1000);
    expect(retryDelayMs(10, cfg)).toBe(1000);
  });

  it("supports zero base delay (no backoff)", () => {
    expect(retryDelayMs(3, { retryBaseDelayMs: 0, retryMaxDelayMs: 1000 })).toBe(0);
  });
});

describe("computeShortTtlMs", () => {
  const cfg = { dynamicTtl: true, minTtlMs: 200, shortTtlMs: 2000 };

  it("falls back to shortTtlMs without an estimate", () => {
    expect(computeShortTtlMs(null, cfg)).toBe(2000);
  });

  it("falls back to shortTtlMs when dynamicTtl is disabled", () => {
    expect(computeShortTtlMs(1000, { ...cfg, dynamicTtl: false })).toBe(2000);
  });

  it("uses blockInterval / 4 within the clamps", () => {
    expect(computeShortTtlMs(4000, cfg)).toBe(1000); // 4000/4
  });

  it("clamps to shortTtlMs for slow chains", () => {
    expect(computeShortTtlMs(12000, cfg)).toBe(2000); // 12000/4 = 3000 > cap
  });

  it("clamps to minTtlMs for fast chains", () => {
    expect(computeShortTtlMs(400, cfg)).toBe(200); // 400/4 = 100 < min
  });
});
