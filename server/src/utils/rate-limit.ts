/**
 * Per-domain rate limiting for collector HTTP (TRD §4.3: "default 1 req/sec,
 * max concurrency 4 domains"). Semantics:
 *
 * - Gap: requests to the SAME domain start at least `gapMs` apart
 *   (timestamp gate, atomic in single-threaded JS — execution may overlap).
 *   Per-request override lets HN use TRD-mandated concurrency 8 (gap 0).
 * - Domain cap: at most 4 domains have in-flight requests at once.
 *   A domain already in flight re-enters freely (so one collector's
 *   concurrency 8 is not throttled by the cross-domain cap).
 */

export interface RateLimiterOptions {
  /** Min ms between request starts on the same domain. Default 1000. */
  gapMs?: number;
  /** Max domains in flight concurrently. Default 4. */
  maxConcurrentDomains?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class DomainRateLimiter {
  private readonly defaultGapMs: number;
  private readonly maxConcurrentDomains: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** domain → epoch ms when the next request may start. */
  private readonly nextAllowedAt = new Map<string, number>();
  /** domain → in-flight request count (active domains = keys with count > 0). */
  private readonly inFlight = new Map<string, number>();
  private readonly waiters: (() => void)[] = [];

  constructor(options: RateLimiterOptions = {}) {
    this.defaultGapMs = options.gapMs ?? 1000;
    this.maxConcurrentDomains = options.maxConcurrentDomains ?? 4;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Acquire the domain's gap slot (+ cross-domain cap), then run fn.
   * `gapOverrideMs` replaces the default gap for this request (0 = no wait).
   */
  async run<T>(domain: string, fn: () => Promise<T>, gapOverrideMs?: number): Promise<T> {
    const gap = gapOverrideMs ?? this.defaultGapMs;

    // Atomic read-modify-set (no await between): reserve the start slot.
    const now = this.now();
    const startAt = Math.max(now, this.nextAllowedAt.get(domain) ?? 0);
    this.nextAllowedAt.set(domain, startAt + gap);

    const wait = startAt - now;
    if (wait > 0) await this.sleep(wait);

    await this.acquireDomain(domain);
    try {
      return await fn();
    } finally {
      this.releaseDomain(domain);
    }
  }

  private async acquireDomain(domain: string): Promise<void> {
    // Re-checked every iteration: while we wait, our own domain may become
    // active (gap-overlap) which makes the cross-domain cap irrelevant to us.
    for (;;) {
      const ownActive = (this.inFlight.get(domain) ?? 0) > 0;
      if (ownActive || this.inFlight.size < this.maxConcurrentDomains) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight.set(domain, (this.inFlight.get(domain) ?? 0) + 1);
  }

  private releaseDomain(domain: string): void {
    const count = (this.inFlight.get(domain) ?? 1) - 1;
    if (count <= 0) this.inFlight.delete(domain);
    else this.inFlight.set(domain, count);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }
}
