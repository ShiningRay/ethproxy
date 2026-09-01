import { randomBytes } from "node:crypto";

/** Filter creation methods: forwarded normally, the response id gets rewritten. */
export const FILTER_CREATE_METHODS = new Set([
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
]);

/** Filter polling methods: params[0] is the filter id, routed to the owning upstream. */
export const FILTER_POLL_METHODS = new Set([
  "eth_getFilterChanges",
  "eth_getFilterLogs",
]);

export const FILTER_UNINSTALL_METHOD = "eth_uninstallFilter";

export function isFilterMethod(method: string): boolean {
  return (
    FILTER_CREATE_METHODS.has(method) ||
    FILTER_POLL_METHODS.has(method) ||
    method === FILTER_UNINSTALL_METHOD
  );
}

export interface FilterMapping {
  upstreamName: string;
  /** The filter id as the upstream node knows it. */
  nodeId: string;
}

interface FilterEntry extends FilterMapping {
  expiresAt: number;
}

/**
 * Sticky routing table for node-local filter ids.
 *
 * Filter state lives in a single node's memory and ids are node-local
 * namespaces (two nodes both hand out "0x1"), so the proxy issues its own
 * globally unique ids and rewrites them in both directions. Entries expire
 * after `ttlMs` of inactivity — matching the node-side behaviour (geth
 * deletes filters not polled for ~5 minutes) — and each successful lookup
 * refreshes the deadline, just as polling refreshes the node's filter.
 */
export class StickyFilterRouter {
  private readonly entries = new Map<string, FilterEntry>();

  constructor(private readonly ttlMs: number) {}

  /** Register a freshly created filter; returns the proxy-side id. */
  register(upstreamName: string, nodeId: string, now = Date.now()): string {
    this.sweep(now);
    const proxyId = `0x${randomBytes(16).toString("hex")}`;
    this.entries.set(proxyId, {
      upstreamName,
      nodeId,
      expiresAt: now + this.ttlMs,
    });
    return proxyId;
  }

  /** Resolve a proxy-side id; refreshes the expiry on hit, like polling does. */
  lookup(proxyId: string, now = Date.now()): FilterMapping | null {
    const entry = this.entries.get(proxyId);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(proxyId);
      return null;
    }
    entry.expiresAt = now + this.ttlMs;
    return { upstreamName: entry.upstreamName, nodeId: entry.nodeId };
  }

  remove(proxyId: string): void {
    this.entries.delete(proxyId);
  }

  /** Lazily drop expired entries; called on register to bound the map size. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
