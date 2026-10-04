/**
 * Today-top route (Doc 16 G3): today's rank-1 topic enriched for the hero
 * card, plus runner-ups and the live sampler status block.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { appRepo } from "./context.js";
import { hasSamples, lastSampleAt, latestSet, mostRecentDate, type IndexedTopic } from "../pulse/index.js";
import type { SortedTrendRecord } from "../sheets/schema.js";

export interface TopicSummary {
  topic_id: string;
  rank: number;
  title: string;
  summary: string;
  why_trending: string;
  first_angle: string;
  category: string;
  momentum: string;
  score: number;
  source_count: number;
  items_count: number;
  has_live_metric: boolean;
}

function summarize(indexed: IndexedTopic, rows: Map<string, SortedTrendRecord>, dbDate: { db: AppContext["db"]; date: string }): TopicSummary {
  const row = rows.get(indexed.topicId);
  const angles = row?.content_angles ?? [];
  return {
    topic_id: indexed.topicId,
    rank: indexed.rank,
    title: indexed.title,
    summary: row?.summary ?? "",
    why_trending: row?.why_trending ?? "",
    first_angle: angles[0] ?? "",
    category: row?.category ?? "",
    momentum: row?.momentum ?? "",
    score: indexed.score,
    source_count: row?.source_count ?? 0,
    items_count: indexed.evidenceIds.length,
    has_live_metric: hasSamples(dbDate.db, indexed.topicId, dbDate.date),
  };
}

export function registerToday(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/today/top", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
    let date = today;
    let set = latestSet(ctx.db, today);
    let fromPreviousDay = false;
    if (set.length === 0) {
      const prev = mostRecentDate(ctx.db);
      if (prev === null) {
        return {
          date: today,
          from_previous_day: false,
          topic: null,
          runner_ups: [],
          live: { enabled: ctx.config.pulseEnabled, last_sample_at: null, next_sample_at: null, interval_min: ctx.config.pulseIntervalMin, status: "paused" as const },
        };
      }
      date = prev;
      fromPreviousDay = true;
      set = latestSet(ctx.db, prev);
    }
    // Enrichment is best-effort: the index alone still answers selection.
    let rows = new Map<string, SortedTrendRecord>();
    try {
      const read = await appRepo(ctx).readSorted({ runDate: date, onlyLatest: false });
      rows = new Map(read.rows.map((row) => [row.topic_id, row]));
    } catch {
      rows = new Map();
    }
    const [top, ...rest] = set;
    const last = lastSampleAt(ctx.db, date);
    const intervalMs = ctx.config.pulseIntervalMin * 60_000;
    const staleAfter = last === null ? 0 : Date.parse(last) + 3 * intervalMs;
    const status = !ctx.config.pulseEnabled ? "paused" : last !== null && Date.now() > staleAfter ? "stale" : "live";
    return {
      date,
      from_previous_day: fromPreviousDay,
      topic: top ? summarize(top, rows, { db: ctx.db, date }) : null,
      runner_ups: rest.slice(0, 4).map((t) => summarize(t, rows, { db: ctx.db, date })),
      live: {
        enabled: ctx.config.pulseEnabled,
        last_sample_at: last,
        next_sample_at: last === null ? null : new Date(Date.parse(last) + intervalMs).toISOString(),
        interval_min: ctx.config.pulseIntervalMin,
        status,
      },
    };
  });
}
