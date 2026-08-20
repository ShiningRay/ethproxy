import type { JsonRpcRequest } from "./rpc.js";

export interface Translation {
  /** The request with translated params (or the original object). */
  request: JsonRpcRequest;
  /** The block number "latest" was translated to; null when untranslated. */
  minBlock: number | null;
}

/** Methods whose block tag sits at a fixed params index (implicit = latest). */
const TAG_INDEX: Record<string, number> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  eth_getBlockByNumber: 0,
};

function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}

/**
 * Translate the "latest" block tag — explicit or implicit (param omitted,
 * which every state method defaults to "latest") — to the pool's locally
 * observed chain head. This makes reads consistent within a poll window and
 * turns cache keys into (method, head) so entries stay valid while the head
 * does not move.
 *
 * "pending"/"safe"/"finalized"/"earliest" and numeric tags are never
 * translated. When the chain head is unknown the request passes through
 * unchanged.
 */
export function translateLatest(
  request: JsonRpcRequest,
  chainHead: number | null,
): Translation {
  if (chainHead === null) return { request, minBlock: null };
  const head = toHex(chainHead);
  const params = Array.isArray(request.params) ? [...request.params] : [];

  if (request.method in TAG_INDEX) {
    const index = TAG_INDEX[request.method]!;
    const tag = params[index];
    if (tag === undefined || tag === "latest") {
      params[index] = head;
      return { request: { ...request, params }, minBlock: chainHead };
    }
    return { request, minBlock: null };
  }

  if (request.method === "eth_getLogs") {
    const filter = params[0];
    if (typeof filter !== "object" || filter === null) {
      return { request, minBlock: null };
    }
    const next = { ...(filter as Record<string, unknown>) };
    let touched = false;
    for (const bound of ["fromBlock", "toBlock"] as const) {
      if (next[bound] === undefined || next[bound] === "latest") {
        next[bound] = head;
        touched = true;
      }
    }
    if (!touched) return { request, minBlock: null };
    return { request: { ...request, params: [next] }, minBlock: chainHead };
  }

  return { request, minBlock: null };
}
