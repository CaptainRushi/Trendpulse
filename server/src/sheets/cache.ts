/** Tiny TTL cache for sheet reads. Sheets are read-heavy (dashboard polls)
 *  and write-rare (one run a day), so a short in-memory TTL with explicit
 *  invalidation after every write keeps the dashboard fast and correct. */

export interface CacheEntry<T> {
  value: T;
  ageS: number;
}

export class SheetsCache {
  private readonly store = new Map<string, { value: unknown; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlSeconds: number, now: () => number = Date.now) {
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    const ageMs = this.now() - entry.at;
    if (ageMs > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return { value: entry.value as T, ageS: Math.floor(ageMs / 1000) };
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { value, at: this.now() });
  }

  invalidate(): void {
    this.store.clear();
  }
}
