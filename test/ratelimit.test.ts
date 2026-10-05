import { describe, expect, it } from "vitest";
import { payloadCost, RateLimiter } from "../src/ratelimit.js";

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

  it("reports the wait until the bucket can afford the next charge", () => {
    const limiter = new RateLimiter(10, 5); // 10/s, capacity 5
    expect(limiter.msUntilAvailable("ip", 1, 0)).toBe(0); // untouched key
    expect(limiter.take("ip", 5, 0)).toBe(true);
    expect(limiter.msUntilAvailable("ip", 1, 0)).toBe(100); // one token = 100ms
    expect(limiter.take("ip", 1, 100)).toBe(true);
    limiter.close();
  });

  it("caps the reported wait when the charge exceeds the capacity", () => {
    const limiter = new RateLimiter(100, 120);
    expect(limiter.take("ip", 120, 0)).toBe(true);
    // cost 100 > remaining 0: the wait is bounded by a full refill.
    expect(limiter.msUntilAvailable("ip", 100, 0)).toBe(1000);
    limiter.close();
  });
});

describe("payloadCost", () => {
  it("charges one per element in items mode", () => {
    expect(payloadCost({ method: "eth_chainId" }, "items")).toBe(1);
    expect(payloadCost([], "items")).toBe(1);
    expect(payloadCost([{}, {}], "items")).toBe(2);
    expect(payloadCost(new Array(100).fill({}), "items")).toBe(100);
  });

  it("charges one per request in request mode", () => {
    expect(payloadCost({ method: "eth_chainId" }, "request")).toBe(1);
    expect(payloadCost([], "request")).toBe(1);
    expect(payloadCost([{}, {}], "request")).toBe(1);
    expect(payloadCost(new Array(100).fill({}), "request")).toBe(1);
  });
});
