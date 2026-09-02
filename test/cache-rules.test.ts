import { describe, expect, it } from "vitest";
import { requestPolicy, responseTtl, type CacheRuleContext } from "../src/cache-rules.js";

const ctx: CacheRuleContext = {
  chainHead: 1000,
  shortTtlMs: 2000,
  pendingTtlMs: 1000,
  unfinalizedTtlMs: 900000,
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

  it("stamps block-number queries near the head with the unfinalized TTL", () => {
    // 990 > 1000 - 64
    expect(requestPolicy("eth_getBlockByNumber", ["0x3de"], ctx)).toEqual({
      cacheable: true,
      ttlMs: 900000,
      stampHeight: 990,
    });
    // state methods keep the short TTL near the head
    expect(requestPolicy("eth_getBalance", ["0xaddr", "0x3de"], ctx)).toEqual({
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
      ttlMs: 900000,
      stampHeight: 16,
    });
    // state methods still fall back to the short TTL
    expect(requestPolicy("eth_getBalance", ["0xaddr", "0x10"], noHead)).toEqual({
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

// ---------------------------------------------------------------------------

import { rawCacheKey } from "../src/cache/index.js";
import { normalizeRawKeyParams, RAW_KEY_METHODS } from "../src/cache-rules.js";

describe("raw cache keys", () => {
  it("embeds normalized params in plain text for the validated methods", () => {
    const key = rawCacheKey(
      "eth_getBlockByNumber",
      normalizeRawKeyParams("eth_getBlockByNumber", ["0x3e9", false]),
    );
    expect(key).toBe('eth_getBlockByNumber:["0x3e9",false]');
  });

  it("canonicalizes quantities to minimal lowercase hex", () => {
    const a = rawCacheKey(
      "eth_getTransactionByBlockNumberAndIndex",
      normalizeRawKeyParams("eth_getTransactionByBlockNumberAndIndex", ["0x03E9", "0x00"]),
    );
    expect(a).toBe('eth_getTransactionByBlockNumberAndIndex:["0x3e9","0x0"]');
    // block tags pass through untouched
    const b = rawCacheKey(
      "eth_getBlockByNumber",
      normalizeRawKeyParams("eth_getBlockByNumber", ["safe", false]),
    );
    expect(b).toBe('eth_getBlockByNumber:["safe",false]');
  });

  it("lowercases transaction hashes without stripping zeros", () => {
    const hash = "0x00ABCDEF0123456789";
    const key = rawCacheKey(
      "eth_getTransactionReceipt",
      normalizeRawKeyParams("eth_getTransactionReceipt", [hash]),
    );
    expect(key).toBe('eth_getTransactionReceipt:["0x00abcdef0123456789"]');
  });

  it("covers exactly the seven reorg-validated methods", () => {
    expect([...RAW_KEY_METHODS].sort()).toEqual([
      "eth_getBlockByNumber",
      "eth_getBlockTransactionCountByNumber",
      "eth_getTransactionByBlockNumberAndIndex",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getUncleByBlockNumberAndIndex",
      "eth_getUncleCountByBlockNumber",
    ]);
  });
});
