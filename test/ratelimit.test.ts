import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to the burst capacity, then denies", () => {
    const limiter = new RateLimiter(1, 3);
    expect(limiter.take("ip", 1, 0)).toBe(true);
    expect(limiter.take("ip", 1, 0)).toBe(true);
    expect(limiter.take("ip", 1, 0)).toBe(true);
    expect(limiter.take("ip", 1, 0)).toBe(false);
    limiter.close();
  });

  it("refills over time", () => {
    const limiter = new RateLimiter(10, 2); // 10 tokens/sec
    expect(limiter.take("ip", 1, 0)).toBe(true);
    expect(limiter.take("ip", 1, 0)).toBe(true);
    expect(limiter.take("ip", 1, 0)).toBe(false);
    expect(limiter.take("ip", 1, 100)).toBe(true); // +1 token after 100ms
    expect(limiter.take("ip", 1, 100)).toBe(false);
    limiter.close();
  });

  it("charges batch cost atomically", () => {
    const limiter = new RateLimiter(1, 5);
    expect(limiter.take("ip", 4, 0)).toBe(true);
    expect(limiter.take("ip", 2, 0)).toBe(false); // only 1 left
    expect(limiter.take("ip", 1, 0)).toBe(true);
    limiter.close();
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter(1, 1);
    expect(limiter.take("a", 1, 0)).toBe(true);
    expect(limiter.take("a", 1, 0)).toBe(false);
    expect(limiter.take("b", 1, 0)).toBe(true);
    limiter.close();
  });
});
