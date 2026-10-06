/**
 * Today-top route (Doc 16 G3): today's rank-1 topic enriched for the hero
 * card, plus runner-ups and the live sampler status block.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./context.js";
import { CATEGORY_REGISTRY, CATEGORY_SLUGS, effectiveSources, normalizeScope } from "../categories/registry.js";
import { categoryOverrides } from "../categories/collect.js";
import { effectiveTopPerCategory, readMyCategories } from "../config/settings.js";
import { sourceStatus } from "./categories.js";
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
  app.get("/api/today/categories", async () => todayCategories(ctx));
  app.get("/api/today/top", async (request) => {
    const query = z.object({ scope: z.string().optional() }).safeParse(request.query);
    let scope = "all";
    if (query.success && query.data.scope !== undefined && query.data.scope !== "") {
      try {
        scope = normalizeScope(query.data.scope.split("+"));
      } catch {
        return {
          date: new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz }),
          scope: query.data.scope,
          hint: `unknown scope '${query.data.scope}' — no set`,
          from_previous_day: false,
          topic: null,
          runner_ups: [],
          live: { enabled: ctx.config.pulseEnabled, last_sample_at: null, next_sample_at: null, interval_min: ctx.config.pulseIntervalMin, status: "paused" as const },
        };
      }
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
    let date = today;
    let set = latestSet(ctx.db, today, scope);
    let fromPreviousDay = false;
    if (set.length === 0) {
      const prev = mostRecentDate(ctx.db, scope);
      if (prev === null) {
        return {
          date: today,
          scope,
          from_previous_day: false,
          topic: null,
          runner_ups: [],
          live: { enabled: ctx.config.pulseEnabled, last_sample_at: null, next_sample_at: null, interval_min: ctx.config.pulseIntervalMin, status: "paused" as const },
        };
      }
      date = prev;
      fromPreviousDay = true;
      set = latestSet(ctx.db, prev, scope);
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
      scope,
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

interface CategoryRunRow {
  status: string;
  items_collected: number;
  items_kept: number;
  topics: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

const PANEL_STATUSES = ["idle", "running", "ok", "partial", "failed", "no_sources"] as const;

/** One panel per selected category (Doc 19 Q1): latest set, sources, status. */
async function todayCategories(ctx: AppContext): Promise<{ categories: unknown[] }> {
  const top = effectiveTopPerCategory(ctx.db, ctx.config);
  const my = readMyCategories(ctx.db).filter((slug) => (CATEGORY_SLUGS as readonly string[]).includes(slug));
  const overrides = categoryOverrides(ctx.db);
  const labelToSlug = new Map<string, string>();
  for (const slug of CATEGORY_SLUGS) {
    const entry = CATEGORY_REGISTRY[slug];
    if (entry) labelToSlug.set(entry.label, slug);
  }
  let rows: SortedTrendRecord[] = [];
  try {
    const read = await appRepo(ctx).readSorted({ onlyLatest: true }, { includeHidden: true });
    rows = read.rows;
  } catch {
    rows = [];
  }
  // Legacy Doc-17 scoped rows (scope outside {"", "all"}) never join a set.
  const valid = rows.filter((row) => (row.scope || "all") === "all" && labelToSlug.has(row.category));
  const categories = my.map((slug) => {
    const label = CATEGORY_REGISTRY[slug]?.label ?? slug;
    const catRows = valid.filter((row) => row.category === label);
    const dates = catRows.map((row) => row.run_date).sort();
    const date: string | undefined = dates[dates.length - 1];
    const dayRows = date === undefined ? [] : catRows.filter((row) => row.run_date === date);
    const visible = dayRows.filter((row) => !row.hidden).sort((a, b) => a.rank - b.rank);
    const hiddenCount = dayRows.filter((row) => row.hidden).length;
    const topics = visible.slice(0, top).map((row) => ({
      id: row.topic_id,
      title: row.title,
      summary: row.summary,
      category: slug,
      score: row.trend_score,
      momentum: row.momentum,
      source_count: row.source_count,
      rank: row.rank,
    }));
    const sources = effectiveSources(slug, overrides).map((source) => {
      const usable = sourceStatus(ctx, source.collector);
      return { name: source.collector, status: usable.usable ? "ok" : "unavailable", hint: usable.hint };
    });
    const noSources = sources.length === 0 || sources.every((s) => s.status !== "ok");
    let run: CategoryRunRow | undefined;
    try {
      run = ctx.db.prepare(
        "SELECT status, items_collected, items_kept, topics, started_at, finished_at, error FROM category_runs WHERE category = ? ORDER BY started_at DESC LIMIT 1",
      ).get(slug) as CategoryRunRow | undefined;
    } catch {
      run = undefined;
    }
    const runStatus =
      run && (PANEL_STATUSES as readonly string[]).includes(run.status) ? run.status : null;
    const status = runStatus ?? (topics.length > 0 ? "ok" : noSources ? "no_sources" : "idle");
    const notes: string[] = [];
    if (status === "failed") notes.push(`failed: ${run?.error ?? "unknown error"}, retry`);
    if (status === "no_sources") notes.push("no usable sources, edit sources in settings");
    if (hiddenCount > 0) notes.push(`${String(hiddenCount)} topic${hiddenCount === 1 ? "" : "s"} hidden by you`);
    if ((status === "ok" || status === "partial") && topics.length < top) {
      notes.push(`only ${String(topics.length)} topic${topics.length === 1 ? "" : "s"} found · sources may be thin`);
    }
    return {
      category: slug,
      status,
      last_run_at: run?.finished_at ?? run?.started_at ?? null,
      sources,
      stats: { items_collected: run?.items_collected ?? 0, items_kept: run?.items_kept ?? 0 },
      topics,
      ...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
    };
  });
  return { categories };
}
