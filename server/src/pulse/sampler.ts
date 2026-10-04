/**
 * Pulse sampler (Doc 16 G1): timer + cycle runner. A cycle refreshes the top-N
 * topics' sampled items, stores samples, records the pulse_cycles row and
 * emits sample/cycle events. Skips (with a skipped cycle row) when disabled,
 * when a pipeline run is active, or when today has no latest set.
 * No AI, Sheets or Composio calls anywhere in this path (PULSE-09).
 */
import type { StateDb } from "../db/sqlite.js";
import type { PipelineEventType } from "../pipeline/events.js";
import type { PulseConfig } from "./config.js";
import { latestSet } from "./index.js";
import { readBaselines, pickSampledItems } from "./index.js";
import type { Refresher, RefreshItem } from "./refresh.js";

export interface SamplerDeps {
  db: StateDb;
  config: PulseConfig;
  refreshers: Refresher[];
  isPipelineActive: () => boolean;
  emit: (type: Extract<PipelineEventType, "sample" | "top_changed" | "cycle">, data: Record<string, unknown>) => void;
  today: () => string;
  nowIso: () => string;
  log?: (message: string) => void;
}

export interface CycleResult {
  status: "ok" | "skipped";
  reason?: string;
  topics: number;
  requests: number;
  sampled: number;
  skipped: number;
  errors: number;
}

/** Growth index: 100 * current/baseline. Zero baseline → no series. */
export function growthIndex(current: number, baseline: number): number {
  if (baseline <= 0) return Number.NaN;
  return (100 * current) / baseline;
}

export class PulseSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** source → date string it was muted after two 429s (PULSE-06). */
  private readonly mutedSources = new Map<string, string>();
  /** "source|date" → 429 count (must survive across cycles to reach two). */
  private readonly rateHits = new Map<string, number>();

  constructor(private readonly deps: SamplerDeps) {}

  start(): void {
    if (this.timer) return;
    const ms = this.deps.config.intervalMin * 60_000;
    this.timer = setInterval(() => {
      void this.runCycle("timer").catch(() => undefined);
    }, ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Retention: drop samples older than retentionDays (PULSE-08). */
  prune(): number {
    const result = this.deps.db
      .prepare("DELETE FROM topic_samples WHERE sampled_at < datetime('now', ?)")
      .run(`-${String(this.deps.config.retentionDays)} days`);
    return result.changes;
  }

  async runCycle(reason: "timer" | "manual"): Promise<CycleResult> {
    const { db, config } = this.deps;
    const startedAt = this.deps.nowIso();
    const finish = (status: "ok" | "skipped", partial: Partial<CycleResult> & { reason?: string }): CycleResult => {
      const result: CycleResult = {
        status,
        topics: 0,
        requests: 0,
        sampled: 0,
        skipped: 0,
        errors: 0,
        ...partial,
      };
      db.prepare(
        "INSERT INTO pulse_cycles (started_at, finished_at, topics, requests, sampled, skipped, errors, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(startedAt, this.deps.nowIso(), result.topics, result.requests, result.sampled, result.skipped, result.errors, `${reason}:${status}${result.reason ? `:${result.reason}` : ""}`);
      this.deps.emit("cycle", { started_at: startedAt, status, reason: result.reason ?? "", sampled: result.sampled, skipped: result.skipped, errors: result.errors });
      return result;
    };
    if (!config.enabled) return finish("skipped", { reason: "disabled" });
    if (this.running) return finish("skipped", { reason: "cycle-active" });
    if (this.deps.isPipelineActive()) return finish("skipped", { reason: "run-active" });
    const today = this.deps.today();
    const set = latestSet(db, today);
    if (set.length === 0) return finish("skipped", { reason: "no-set" });
    this.running = true;
    try {
      const baselines = readBaselines(db, today);
      const insertSample = db.prepare(
        "INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      let requests = 0;
      let sampled = 0;
      let skipped = 0;
      let errors = 0;
      const top = set.slice(0, config.topN);
      for (const topic of top) {
        const items = pickSampledItems(topic.evidenceIds, baselines).filter((item) => !this.isMuted(item.source, today));
        if (items.length === 0) {
          skipped += 1;
          continue;
        }
        const outcome = await this.refreshItems(items, config, today);
        requests += outcome.requests;
        const attempted = items.length - outcome.skipped;
        if (attempted === 0) {
          skipped += 1;
          continue;
        }
        if (outcome.failed === attempted) {
          errors += 1;
          continue;
        }
        const baselineTotal = items.reduce((sum, item) => sum + item.baseline, 0);
        const currentTotal = items.reduce((sum, item) => sum + (outcome.values.get(item.itemId) ?? item.lastValue), 0);
        const index = growthIndex(currentTotal, baselineTotal);
        if (Number.isNaN(index)) {
          skipped += 1;
          continue;
        }
        insertSample.run(topic.topicId, startedAt, index, currentTotal, attempted - outcome.failed, outcome.failed, JSON.stringify(outcome.detail));
        sampled += 1;
        this.deps.emit("sample", { topic_id: topic.topicId, t: startedAt, index, total: currentTotal });
      }
      return finish("ok", { topics: top.length, requests, sampled, skipped, errors });
    } finally {
      this.running = false;
    }
  }

  private isMuted(source: string, today: string): boolean {
    return this.mutedSources.get(source) === today;
  }

  private async refreshItems(
    items: RefreshItem[],
    config: PulseConfig,
    today: string,
  ): Promise<{ values: Map<string, number>; failed: number; skipped: number; requests: number; detail: Record<string, unknown>[] }> {
    const values = new Map<string, number>();
    const detail: Record<string, unknown>[] = [];
    let failed = 0;
    let skipped = 0;
    let requests = 0;
    const bySource = new Map<string, RefreshItem[]>();
    for (const item of items) {
      const list = bySource.get(item.source) ?? [];
      list.push(item);
      bySource.set(item.source, list);
    }
    const byId = new Map(items.map((item) => [item.itemId, item]));
    for (const [source, group] of bySource) {
      const refresher = this.deps.refreshers.find((r) => r.source === source);
      if (!refresher) {
        for (const item of group) detail.push({ item_id: item.itemId, skipped: "no live metric" });
        skipped += group.length;
        continue;
      }
      const room = config.maxRequests - requests;
      if (room <= 0) {
        failed += group.length;
        continue;
      }
      const outcomes = await refresher.refresh(group.slice(0, room));
      requests += outcomes.length;
      for (const outcome of outcomes) {
        if (outcome.value !== undefined) {
          values.set(outcome.itemId, outcome.value);
          detail.push({ item_id: outcome.itemId, value: outcome.value });
        } else if (outcome.unchanged === true) {
          const last = byId.get(outcome.itemId)?.lastValue ?? 0;
          values.set(outcome.itemId, last);
          detail.push({ item_id: outcome.itemId, unchanged: true, value: last });
        } else if (outcome.skipped !== undefined) {
          skipped += 1;
          detail.push({ item_id: outcome.itemId, skipped: outcome.skipped });
        } else {
          failed += 1;
          detail.push({ item_id: outcome.itemId, error: outcome.error ?? "failed" });
          if (outcome.error && /\b429\b/.test(outcome.error)) {
            const key = `${source}|${today}`;
            const count = (this.rateHits.get(key) ?? 0) + 1;
            this.rateHits.set(key, count);
            if (count >= 2) this.mutedSources.set(source, today);
          }
        }
      }
    }
    return { values, failed, skipped, requests, detail };
  }
}
