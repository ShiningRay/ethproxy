export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown[];
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.method === "string" && "id" in v;
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const n = Number.parseInt(value, 16);
  return Number.isNaN(n) ? null : n;
}

/** Recursively sort object keys so equivalent params produce identical keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

const MAX_LOG_PARAM_CHARS = 200;
const MAX_LOG_BATCH_METHODS = 10;

/**
 * Format a JSON-RPC request (or batch) as a short human-readable summary for
 * request logging. Params are truncated to keep log lines readable.
 */
export function formatRequestForLog(body: unknown): string {
  if (Array.isArray(body)) {
    const methods = body.map((item) =>
      isJsonRpcRequest(item) ? item.method : "invalid",
    );
    const shown = methods.slice(0, MAX_LOG_BATCH_METHODS).join(", ");
    const suffix =
      methods.length > MAX_LOG_BATCH_METHODS
        ? `, ...(${methods.length - MAX_LOG_BATCH_METHODS} more)`
        : "";
    return `batch[${body.length}]: ${shown}${suffix}`;
  }
  if (!isJsonRpcRequest(body)) {
    return "invalid request";
  }
  const params = Array.isArray(body.params) ? body.params : [];
  const text = params.map((p) => JSON.stringify(p)).join(", ");
  const paramsStr =
    text.length > MAX_LOG_PARAM_CHARS
      ? `${text.slice(0, MAX_LOG_PARAM_CHARS)}...`
      : text;
  return `${body.method} [${paramsStr}]`;
}
