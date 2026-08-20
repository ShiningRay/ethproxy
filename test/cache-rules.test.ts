import { describe, expect, it } from "vitest";
import { requestPolicy, responseTtl, type CacheRuleContext } from "../src/cache-rules.js";

const ctx: CacheRuleContext = {
  chainHead: 1000,
  shortTtlMs: 2000,
  pendingTtlMs: 1000,
  finalityDepth: 64,
};

describe("requestPolicy", () => {
  it("caches hash-keyed methods with response-decided TTL", () => {
    for (const method of [
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
      "eth_getBlockTransactionCountByHash",
    ]) {
      expect(requestPolicy(method, ["0xabc"], ctx)).toEqual({
        cacheable: true,
        ttlMs: "by-response",
      });
    }
  });

  it("permanently caches deep block-number queries", () => {
    expect(requestPolicy("eth_getBlockByNumber", ["0x100"], ctx)).toEqual({
      cacheable: true,
      ttlMs: null,
    });
  });

  it("short-caches block-number queries near the head", () => {
    // 990 > 1000 - 64
    expect(requestPolicy("eth_getBlockByNumber", ["0x3de"], ctx)).toEqual({
      cacheable: true,
      ttlMs: 2000,
    });
  });

  it("never caches future blocks", () => {
    expect(
      requestPolicy("eth_getBlockByNumber", ["0x10000"], ctx).cacheable,
    ).toBe(false);
  });

  it("short-caches 'latest'/'safe'/'finalized' state queries", () => {
    for (const tag of ["latest", "safe", "finalized"]) {
      expect(requestPolicy("eth_getBalance", ["0xaddr", tag], ctx)).toEqual({
        cacheable: true,
        ttlMs: 2000,
      });
    }
    // eth_call with an explicit deep block number is permanent
    expect(
      requestPolicy("eth_call", [{ to: "0x1", data: "0x" }, "0x10"], ctx),
    ).toEqual({ cacheable: true, ttlMs: null });
    // eth_call without a tag defaults to latest -> short TTL
    expect(requestPolicy("eth_call", [{ to: "0x1", data: "0x" }], ctx)).toEqual(
      { cacheable: true, ttlMs: 2000 },
    );
  });

  it("never caches 'pending' queries", () => {
    expect(requestPolicy("eth_call", [{}, "pending"], ctx).cacheable).toBe(
      false,
    );
    expect(
      requestPolicy("eth_getBlockByNumber", ["pending"], ctx).cacheable,
    ).toBe(false);
    expect(
      requestPolicy("eth_getLogs", [{ fromBlock: "0x1", toBlock: "pending" }], ctx)
        .cacheable,
    ).toBe(false);
  });

  it("caches finalized eth_getLogs ranges permanently", () => {
    expect(
      requestPolicy("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x100" }], ctx),
    ).toEqual({ cacheable: true, ttlMs: null });
    // range reaching the head: short TTL
    expect(
      requestPolicy("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x3e8" }], ctx),
    ).toEqual({ cacheable: true, ttlMs: 2000 });
  });

  it("short-caches head-dependent reads", () => {
    for (const method of ["eth_blockNumber", "eth_gasPrice", "eth_syncing"]) {
      expect(requestPolicy(method, [], ctx)).toEqual({
        cacheable: true,
        ttlMs: 2000,
      });
    }
  });

  it("long-caches chain constants", () => {
    expect(requestPolicy("eth_chainId", [], ctx)).toEqual({
      cacheable: true,
      ttlMs: 3600000,
    });
    expect(requestPolicy("net_version", [], ctx)).toEqual({
      cacheable: true,
      ttlMs: 3600000,
    });
  });

  it("never caches write and admin methods", () => {
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_accounts",
      "admin_peers",
      "personal_unlockAccount",
      "txpool_content",
      "debug_traceTransaction",
    ]) {
      expect(requestPolicy(method, [], ctx).cacheable).toBe(false);
    }
  });

  it("fails safe on unknown methods", () => {
    expect(requestPolicy("eth_someFutureMethod", [], ctx).cacheable).toBe(false);
  });

  it("treats numeric blocks as near-head when the chain head is unknown", () => {
    const noHead = { ...ctx, chainHead: null };
    expect(requestPolicy("eth_getBlockByNumber", ["0x10"], noHead)).toEqual({
      cacheable: true,
      ttlMs: 2000,
    });
  });
});

describe("responseTtl", () => {
  it("permanently caches mined receipts, briefly caches pending ones", () => {
    expect(
      responseTtl("eth_getTransactionReceipt", { blockHash: "0xabc" }, ctx),
    ).toBeNull();
    expect(responseTtl("eth_getTransactionReceipt", null, ctx)).toBe(1000);
  });

  it("permanently caches found hash-keyed data, briefly caches null", () => {
    expect(responseTtl("eth_getTransactionByHash", { hash: "0x1" }, ctx)).toBeNull();
    expect(responseTtl("eth_getTransactionByHash", null, ctx)).toBe(1000);
  });
});
