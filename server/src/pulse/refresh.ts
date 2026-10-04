/**
 * Refresher interface (Doc 16 G1/G2): one implementation per refreshable
 * source. Baseline is always engagement_score at persist time (HN points,
 * GH stars) — refreshers return the current value of the same metric.
 */

export interface RefreshItem {
  itemId: string;
  source: string;
  url: string;
  /** Collector's native id (HN numeric id); "" when unknown. */
  sourceItemId: string;
  /** engagement_score when the topic was written (t0). */
  baseline: number;
  /** Last known current value (carry-forward when a cycle fails). */
  lastValue: number;
}

export interface RefreshOutcome {
  itemId: string;
  /** Absent when the refresh failed (caller carries lastValue forward). */
  value?: number;
  /** 304 / not-modified: caller reuses lastValue and counts it sampled. */
  unchanged?: boolean;
  error?: string;
  skipped?: string;
}

export interface Refresher {
  readonly source: string;
  canRefresh(item: Pick<RefreshItem, "source" | "url">): boolean;
  refresh(items: RefreshItem[]): Promise<RefreshOutcome[]>;
}

/** Sources with re-readable counts. Reddit needs OAuth (G2 stub skips). */
export function isRefreshableSource(source: string): boolean {
  return source === "hackernews" || source === "github" || source === "reddit";
}
