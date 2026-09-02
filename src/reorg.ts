/**
 * Reorg detection from observed newHeads announcements.
 *
 * The detector keeps a sliding window of recent headers (number -> hash,
 * parentHash) representing the pool's best-known canonical chain and checks
 * every distinct announced head for continuity. A bare conflict is only a
 * *candidate*: upstreams briefly disagree about the tip all the time, so a
 * candidate is confirmed as a reorg only when the chain demonstrably adopts
 * the conflicting branch — either a later head builds on top of it (its
 * parentHash references the candidate) or a second, distinct upstream
 * announces the same conflicting hash. Candidates that attract neither
 * expire silently as upstream noise.
 */

export interface ReorgEvent {
  /** First replaced height (fork point + 1). */
  fromNumber: number;
  /** Last replaced height (the old canonical tip). */
  toNumber: number;
  /** Number of replaced blocks: toNumber - fromNumber + 1. */
  depth: number;
  /**
   * True when the fork point was found in the observed window (depth is
   * exact); false when the fork is deeper than the window can see and the
   * depth is a lower bound.
   */
  exact: boolean;
  /** Hash of the new branch's block at the conflicting height. */
  newHash: string;
  /** Hash we had recorded at fromNumber on the old chain, when known. */
  oldHash: string | null;
}

export interface ObservedHead {
  number: number;
  hash: string;
  parentHash: string;
}

interface WindowEntry {
  hash: string;
  parentHash: string;
}

interface Candidate {
  number: number;
  hash: string;
  parentHash: string;
  firstSeenAt: number;
  /** Distinct upstreams that announced this exact conflicting hash. */
  seenBy: Set<string>;
}

export interface ReorgDetectorOptions {
  /** Sliding window size in headers; bounds fork-point lookup depth. */
  windowSize?: number;
  /** How long an unconfirmed candidate is kept before expiring as noise. */
  candidateTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

const DEFAULT_WINDOW_SIZE = 128;
const DEFAULT_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 32;

export class ReorgDetector {
  private readonly window = new Map<number, WindowEntry>();
  private tipNumber: number | null = null;
  private readonly pending = new Map<string, Candidate>();

  private readonly windowSize: number;
  private readonly candidateTtlMs: number;
  private readonly now: () => number;

  constructor(options: ReorgDetectorOptions = {}) {
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * The canonical hash currently recorded at height `n`, or null when the
   * window does not cover that height (evicted, gap, or never seen).
   * Used by the response cache for read-time reorg validation.
   */
  canonicalHashAt(n: number): string | null {
    return this.window.get(n)?.hash ?? null;
  }

  /**
   * Feed one distinct observed head (already deduped by hash across
   * upstreams). Returns the reorg events confirmed by this head — almost
   * always empty, at most one entry.
   */
  observe(head: ObservedHead, upstreamName: string): ReorgEvent[] {
    this.sweepExpired();
    const { number: n, hash: h, parentHash: p } = head;

    // The head builds on a pending candidate: the chain itself adopted the
    // conflicting branch — the reorg is confirmed regardless of how many
    // upstreams reported it.
    const parentCandidate = this.pending.get(p);
    if (parentCandidate !== undefined) {
      const event = this.confirm(parentCandidate);
      this.insert(n, h, p);
      return [event];
    }

    // A known candidate re-announced: a second distinct upstream reporting
    // the same conflicting hash confirms it.
    const self = this.pending.get(h);
    if (self !== undefined) {
      self.seenBy.add(upstreamName);
      if (self.seenBy.size >= 2) return [this.confirm(self)];
      return [];
    }

    if (this.tipNumber === null) {
      this.insert(n, h, p);
      return [];
    }

    if (n > this.tipNumber) {
      if (n === this.tipNumber + 1) {
        if (p === this.window.get(this.tipNumber)?.hash) {
          this.insert(n, h, p);
          return [];
        }
        // The successor of our tip claims a different parent: structural
        // evidence that the tip height was replaced. Arbitrated like any
        // other candidate — confirmed by its child or a second upstream.
        this.addCandidate(head, upstreamName);
        return [];
      }
      // Gap: intermediate heads were missed (WS reconnect, late startup).
      // Continuity across the gap cannot be verified from subscription data
      // alone; keep the old window and continue from the new head. A reorg
      // hidden inside the gap goes undetected — polls/backfill are the
      // remedy, not guesswork here.
      this.insert(n, h, p);
      return [];
    }

    const existing = this.window.get(n);
    if (existing === undefined) return []; // evicted or a hole: nothing to compare
    if (existing.hash === h) return []; // consistent re-announcement
    // Same height, different hash: conflicting head, await confirmation.
    this.addCandidate(head, upstreamName);
    return [];
  }

  private addCandidate(head: ObservedHead, upstreamName: string): void {
    if (this.pending.size >= MAX_PENDING) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [hash, c] of this.pending) {
        if (c.firstSeenAt < oldestAt) {
          oldest = hash;
          oldestAt = c.firstSeenAt;
        }
      }
      if (oldest !== null) this.pending.delete(oldest);
    }
    this.pending.set(head.hash, {
      ...head,
      firstSeenAt: this.now(),
      seenBy: new Set([upstreamName]),
    });
  }

  private sweepExpired(): void {
    const cutoff = this.now() - this.candidateTtlMs;
    for (const [hash, c] of this.pending) {
      if (c.firstSeenAt < cutoff) this.pending.delete(hash);
    }
  }

  /**
   * Confirm a candidate as a reorg: locate the fork point in the window,
   * drop the replaced heights, and make the candidate the new canonical tip.
   */
  private confirm(c: Candidate): ReorgEvent {
    // The candidate's parent sits at height c.number - 1; if it matches our
    // record there, the fork is exactly at that height. Otherwise scan
    // deeper (a block hash exists at exactly one height, so any match is
    // the fork point). No match: the fork is deeper than the window — but
    // when we hold a *different* hash at the parent's height, that height
    // is known to be replaced, which bounds the range from below.
    let fork = -1;
    let fromNumber: number;
    const parentEntry = this.window.get(c.number - 1);
    if (parentEntry !== undefined && parentEntry.hash === c.parentHash) {
      fork = c.number - 1;
    } else {
      for (const [num, entry] of this.window) {
        if (entry.hash === c.parentHash) fork = num; // unique if present
      }
    }
    const exact = fork >= 0;
    if (exact) {
      fromNumber = fork + 1;
    } else {
      // The parent's own height is provably replaced when we recorded a
      // different block there; otherwise all we know is the candidate's.
      fromNumber = parentEntry !== undefined ? c.number - 1 : c.number;
    }
    // The old tip may have advanced while the candidate awaited confirmation.
    const oldTip = Math.max(this.tipNumber ?? c.number - 1, c.number - 1);
    const depth = oldTip - fromNumber + 1;
    const oldHash = this.window.get(fromNumber)?.hash ?? null;

    // Rebuild: replaced heights go. When the fork is unknown the entries
    // below fromNumber are unverified but likely still canonical — keep
    // them (a wrong entry deeper down surfaces as a new candidate later).
    for (const num of [...this.window.keys()]) {
      if (num >= fromNumber) this.window.delete(num);
    }
    this.window.set(c.number, { hash: c.hash, parentHash: c.parentHash });
    this.tipNumber = c.number;
    this.pending.clear();
    this.evict();

    return { fromNumber, toNumber: oldTip, depth, exact, newHash: c.hash, oldHash };
  }

  private insert(n: number, hash: string, parentHash: string): void {
    this.window.set(n, { hash, parentHash });
    this.tipNumber = n;
    this.evict();
  }

  private evict(): void {
    while (this.window.size > this.windowSize) {
      let min = Infinity;
      for (const num of this.window.keys()) if (num < min) min = num;
      this.window.delete(min);
    }
  }
}
