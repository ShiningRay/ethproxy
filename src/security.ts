import type { SecurityConfig } from "./config.js";
import { parseQuantity } from "./rpc.js";

/**
 * Whether a method belongs to a blocked namespace (the part before the
 * first underscore, e.g. "debug" in debug_traceTransaction).
 */
export function isMethodBlocked(method: string, security: SecurityConfig): boolean {
  const namespace = method.split("_", 1)[0]!;
  return security.blockedNamespaces.includes(namespace);
}

/**
 * eth_getLogs span guard. Resolves block tags against the known chain head
 * and returns an error message when the range exceeds maxLogsRange, or null
 * when the request is acceptable.
 */
export function logsRangeViolation(
  params: unknown[],
  chainHead: number | null,
  security: SecurityConfig,
): string | null {
  const filter = params[0];
  if (typeof filter !== "object" || filter === null) return null;
  const { fromBlock, toBlock } = filter as Record<string, unknown>;

  const resolve = (tag: unknown, fallback: "earliest" | "latest"): number | null => {
    const t = tag === undefined ? fallback : tag;
    if (t === "earliest") return 0;
    if (t === "latest" || t === "safe" || t === "finalized" || t === "pending") {
      return chainHead;
    }
    return parseQuantity(t);
  };

  const from = resolve(fromBlock, "latest");
  const to = resolve(toBlock, "latest");
  if (from === null || to === null) return null; // unknown head: skip span check
  if (to - from > security.maxLogsRange) {
    return `eth_getLogs block range ${to - from} exceeds limit ${security.maxLogsRange}`;
  }
  return null;
}
