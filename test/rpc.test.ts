import { describe, expect, it } from "vitest";
import { formatRequestForLog } from "../src/rpc.js";

describe("formatRequestForLog", () => {
  it("formats a single request with params", () => {
    const body = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    };
    expect(formatRequestForLog(body)).toBe(
      'eth_getBalance ["0xabc", "latest"]',
    );
  });

  it("formats a single request without params", () => {
    const body = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "eth_blockNumber",
    };
    expect(formatRequestForLog(body)).toBe("eth_blockNumber []");
  });

  it("formats a batch request", () => {
    const body = [
      { jsonrpc: "2.0" as const, id: 1, method: "eth_blockNumber" },
      { jsonrpc: "2.0" as const, id: 2, method: "eth_getBalance", params: ["0xabc"] },
    ];
    expect(formatRequestForLog(body)).toBe("batch[2]: eth_blockNumber, eth_getBalance");
  });

  it("marks invalid items in a batch", () => {
    const body = [{ jsonrpc: "2.0" as const, id: 1, method: "eth_blockNumber" }, "bad"];
    expect(formatRequestForLog(body)).toBe("batch[2]: eth_blockNumber, invalid");
  });

  it("summarizes large batches", () => {
    const body = Array.from({ length: 12 }, (_, i) => ({
      jsonrpc: "2.0" as const,
      id: i,
      method: `method_${i}`,
    }));
    expect(formatRequestForLog(body)).toBe(
      "batch[12]: method_0, method_1, method_2, method_3, method_4, method_5, method_6, method_7, method_8, method_9, ...(2 more)",
    );
  });

  it("truncates long params", () => {
    const longParam = "a".repeat(250);
    const body = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "eth_call",
      params: [{ data: longParam }, "latest"],
    };
    const formatted = formatRequestForLog(body);
    expect(formatted.startsWith("eth_call [")).toBe(true);
    expect(formatted.endsWith("...]")).toBe(true);
  });

  it("formats invalid requests", () => {
    expect(formatRequestForLog("not json rpc")).toBe("invalid request");
    expect(formatRequestForLog({ foo: "bar" })).toBe("invalid request");
  });
});
