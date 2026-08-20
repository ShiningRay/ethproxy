import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "../src/rpc.js";
import { translateLatest } from "../src/translate.js";

const HEAD = 1000;
const HEX_HEAD = "0x3e8";

function req(method: string, params: unknown[]): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params };
}

describe("translateLatest", () => {
  it("translates explicit latest tags", () => {
    const t = translateLatest(req("eth_getBalance", ["0xaddr", "latest"]), HEAD);
    expect(t.request.params).toEqual(["0xaddr", HEX_HEAD]);
    expect(t.minBlock).toBe(HEAD);
  });

  it("appends translated tag for implicit latest (param omitted)", () => {
    // eth_call with only the tx object
    expect(
      translateLatest(req("eth_call", [{ to: "0x1", data: "0x" }]), HEAD).request.params,
    ).toEqual([{ to: "0x1", data: "0x" }, HEX_HEAD]);
    // eth_getBalance without tag
    expect(
      translateLatest(req("eth_getBalance", ["0xaddr"]), HEAD).request.params,
    ).toEqual(["0xaddr", HEX_HEAD]);
    // eth_getStorageAt without tag (tag index 2)
    expect(
      translateLatest(req("eth_getStorageAt", ["0xaddr", "0x0"]), HEAD).request.params,
    ).toEqual(["0xaddr", "0x0", HEX_HEAD]);
    // eth_getBlockByNumber without tag
    expect(
      translateLatest(req("eth_getBlockByNumber", []), HEAD).request.params,
    ).toEqual([HEX_HEAD]);
  });

  it("never translates pending/safe/finalized/earliest/numeric tags", () => {
    for (const tag of ["pending", "safe", "finalized", "earliest", "0x10"]) {
      const t = translateLatest(req("eth_getBalance", ["0xaddr", tag]), HEAD);
      expect(t.request.params).toEqual(["0xaddr", tag]);
      expect(t.minBlock).toBeNull();
    }
  });

  it("translates eth_getLogs latest/missing bounds only", () => {
    const t = translateLatest(req("eth_getLogs", [{ fromBlock: "0x10" }]), HEAD);
    expect(t.request.params).toEqual([{ fromBlock: "0x10", toBlock: HEX_HEAD }]);

    const both = translateLatest(
      req("eth_getLogs", [{ fromBlock: "latest", toBlock: "latest" }]),
      HEAD,
    );
    expect(both.request.params).toEqual([{ fromBlock: HEX_HEAD, toBlock: HEX_HEAD }]);

    const numeric = translateLatest(
      req("eth_getLogs", [{ fromBlock: "0x10", toBlock: "0x20" }]),
      HEAD,
    );
    expect(numeric.request.params).toEqual([{ fromBlock: "0x10", toBlock: "0x20" }]);
    expect(numeric.minBlock).toBeNull();

    const pending = translateLatest(
      req("eth_getLogs", [{ fromBlock: "0x10", toBlock: "pending" }]),
      HEAD,
    );
    expect(pending.request.params).toEqual([{ fromBlock: "0x10", toBlock: "pending" }]);
  });

  it("leaves everything unchanged when the chain head is unknown", () => {
    const r = req("eth_getBalance", ["0xaddr", "latest"]);
    const t = translateLatest(r, null);
    expect(t.request).toBe(r);
    expect(t.minBlock).toBeNull();
  });

  it("does not touch unrelated methods", () => {
    const r = req("eth_sendRawTransaction", ["0xsigned"]);
    const t = translateLatest(r, HEAD);
    expect(t.request).toBe(r);
    expect(t.minBlock).toBeNull();
  });

  it("does not mutate the original request or params array", () => {
    const params = ["0xaddr", "latest"];
    const r = req("eth_getBalance", params);
    translateLatest(r, HEAD);
    expect(r.params).toEqual(["0xaddr", "latest"]);
  });
});
