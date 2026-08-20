import { describe, expect, it } from "vitest";
import type { SecurityConfig } from "../src/config.js";
import { isMethodBlocked, logsRangeViolation } from "../src/security.js";

const security: SecurityConfig = {
  blockedNamespaces: ["admin", "personal", "debug", "trace", "miner", "txpool"],
  maxBatchSize: 100,
  maxBodyBytes: 1048576,
  maxLogsRange: 10000,
};

describe("isMethodBlocked", () => {
  it("blocks configured namespaces", () => {
    for (const m of [
      "admin_peers",
      "personal_unlockAccount",
      "debug_traceTransaction",
      "trace_call",
      "miner_start",
      "txpool_content",
    ]) {
      expect(isMethodBlocked(m, security)).toBe(true);
    }
  });

  it("allows regular eth_/net_/web3_ methods", () => {
    for (const m of ["eth_blockNumber", "eth_call", "eth_getLogs", "net_version", "web3_sha3"]) {
      expect(isMethodBlocked(m, security)).toBe(false);
    }
  });
});

describe("logsRangeViolation", () => {
  const head = 100000;

  it("accepts ranges within the limit", () => {
    expect(
      logsRangeViolation([{ fromBlock: "0x10", toBlock: "0x20" }], head, security),
    ).toBeNull();
  });

  it("rejects numeric ranges beyond the limit", () => {
    // 0 to 20000 > 10000
    expect(
      logsRangeViolation([{ fromBlock: "0x0", toBlock: "0x4e20" }], head, security),
    ).toContain("exceeds limit");
  });

  it("resolves tags against the chain head", () => {
    // fromBlock 0 to "latest" (head 100000) exceeds the limit
    expect(
      logsRangeViolation([{ fromBlock: "0x0", toBlock: "latest" }], head, security),
    ).toContain("exceeds limit");
    // near-head range is fine
    expect(
      logsRangeViolation([{ fromBlock: "0x18690", toBlock: "latest" }], head, security),
    ).toBeNull();
    // missing toBlock defaults to latest
    expect(
      logsRangeViolation([{ fromBlock: "0x0" }], head, security),
    ).toContain("exceeds limit");
  });

  it("skips the span check when the chain head is unknown", () => {
    expect(
      logsRangeViolation([{ fromBlock: "0x0", toBlock: "latest" }], null, security),
    ).toBeNull();
  });

  it("ignores malformed filters", () => {
    expect(logsRangeViolation([], head, security)).toBeNull();
    expect(logsRangeViolation(["nonsense"], head, security)).toBeNull();
  });
});
