/**
 * Content reads: trends, topic detail, digest, raw rows, dates.
 * Filters mirror schema §4; unknown enum values are 400s (typos should
 * fail loudly, not silently empty). Raw `date` filters on the collected_at
 * UTC day — raw rows carry no run_date; the app-tz date lives in runs.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "./errors.js";
import type { AppContext } from "./context.js";
import { appRepo } from "./context.js";
import { normalizeScope } from "../categories/registry.js";
import {
  Category,
  Momentum,
  RawTrendRecord,
  SortedTrendRecord,
  SourceKey,
} from "../sheets/schema.js";

const listOf = (item: z.ZodTypeAny): z.ZodType<string[]> =>
  z.preprocess((value: unknown): string[] => {
    if (value === undefined) return [];
    const items = Array.isArray(value) ? value : [value];
    return items.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  }, z.array(item)) as z.ZodType<string[]>;

const TrendsQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  category: listOf(Category),
  source: listOf(SourceKey),
  momentum: listOf(Momentum),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().optional(),
  sort: z.enum(["score", "rank", "title"]).default("score"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  scope: z.string().optional(),
});
export type TrendsFilter = z.infer<typeof TrendsQuery> & { date: string };

export function parseTrendsQuery(ctx: AppContext, query: unknown): TrendsFilter {
  const result = TrendsQuery.safeParse(query);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(
      `Invalid query${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    );
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
  return { ...result.data, date: result.data.date ?? today };
}

export const TrendsResponse = z.object({
  date: z.string(),
  scope: z.string().default("all"),
  hint: z.string().optional(),
  items: z.array(SortedTrendRecord),
  total: z.number().int(),
  warnings: z.number().int(),
  cache: z.object({ age_s: z.number() }),
});

export interface TrendsResult {
  date: string;
  scope: string;
  hint?: string;
  items: z.infer<typeof SortedTrendRecord>[];
  total: number;
  warnings: number;
  ageS: number;
}

export async function loadTrends(ctx: AppContext, filter: TrendsFilter): Promise<TrendsResult> {
  const repo = appRepo(ctx);
  // Unknown scopes answer empty with a hint, never an error (CATRUN-11).
  let scope = "all";
  try {
    scope = normalizeScope(filter.scope === undefined || filter.scope === "" ? [] : filter.scope.split("+"));
  } catch {
    return { date: filter.date, scope: filter.scope ?? "all", hint: `unknown scope '${filter.scope ?? ""}' — no set`, items: [], total: 0, warnings: 0, ageS: 0 };
  }
  const sorted = await repo.readSorted({ runDate: filter.date, onlyLatest: true });
  let warnings = sorted.warnings;
  let ageS = sorted.ageS;
  let idToSource: Map<string, string> | null = null;
  if (filter.source.length > 0) {
    const raw = await repo.readRaw();
    warnings += raw.warnings;
    ageS = Math.max(ageS, raw.ageS);
    idToSource = new Map(raw.rows.map((row) => [row.id, row.source]));
  }
  const q = filter.q?.toLowerCase();
  const items = sorted.rows.filter(
    (topic) =>
      ((topic.scope || "all") === scope) &&
      (filter.category.length === 0 || filter.category.includes(topic.category)) &&
      (filter.momentum.length === 0 || filter.momentum.includes(topic.momentum)) &&
      (filter.min_score === undefined || topic.trend_score >= filter.min_score) &&
      (!q || topic.title.toLowerCase().includes(q) || topic.summary.toLowerCase().includes(q)) &&
      (!idToSource ||
        topic.evidence_item_ids.some((id) => {
          const source = idToSource.get(id);
          return source !== undefined && filter.source.includes(source);
        })),
  );
  if (filter.sort === "title") items.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  else items.sort((a, b) => a.rank - b.rank); // rank == score order; "score" identical
  const total = items.length;
  return { date: filter.date, scope, items: items.slice(filter.offset, filter.offset + filter.limit), total, warnings, ageS };
}

const TopicParams = z.object({ topic_id: z.string().min(1) });

export const TopicResponse = z.object({
  topic: SortedTrendRecord,
  evidence: z.array(RawTrendRecord),
  warnings: z.number().int(),
  cache: z.object({ age_s: z.number() }),
});

const RawQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  source: listOf(SourceKey),
  status: listOf(z.enum(["pending", "sorted", "discarded", "sort_failed"])),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const RawResponse = z.object({
  date: z.string().nullable(),
  items: z.array(RawTrendRecord.extend({ sort_status: z.string().nullable() })),
  total: z.number().int(),
  warnings: z.number().int(),
  cache: z.object({ age_s: z.number() }),
});

export function registerTrends(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/trends", async (request) => {
    const filter = parseTrendsQuery(ctx, request.query);
    const result = await loadTrends(ctx, filter);
    return TrendsResponse.parse({
      date: result.date,
      scope: result.scope,
      ...(result.hint ? { hint: result.hint } : {}),
      items: result.items,
      total: result.total,
      warnings: result.warnings,
      cache: { age_s: result.ageS },
    });
  });

  app.get("/api/trends/:topic_id", async (request) => {
    const params = TopicParams.parse(request.params);
    const repo = appRepo(ctx);
    const sorted = await repo.readSorted({ onlyLatest: false });
    const matches = sorted.rows.filter((row) => row.topic_id === params.topic_id);
    if (matches.length === 0) throw notFound(`No topic '${params.topic_id}'.`);
    matches.sort(
      (a, b) => Number(b.is_latest) - Number(a.is_latest) || (a.run_date < b.run_date ? 1 : -1),
    );
    const topic = matches[0];
    if (!topic) throw notFound(`No topic '${params.topic_id}'.`);
    const raw = await repo.readRaw();
    const byId = new Map(raw.rows.map((row) => [row.id, row]));
    const evidence: z.infer<typeof RawTrendRecord>[] = [];
    let missing = 0;
    for (const id of topic.evidence_item_ids) {
      const record = byId.get(id);
      if (record) evidence.push(record);
      else missing += 1;
    }
    return TopicResponse.parse({
      topic,
      evidence,
      warnings: sorted.warnings + raw.warnings + missing,
      cache: { age_s: Math.max(sorted.ageS, raw.ageS) },
    });
  });

  app.get("/api/digest", async (request) => {
    const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(request.query);
    if (!parsed.success) throw badRequest("Invalid query: date must be YYYY-MM-DD.");
    const date =
      parsed.data.date ?? new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
    const result = await appRepo(ctx).readDigest(date);
    if (!result.row) throw notFound(`No digest for ${date}.`);
    return result.row;
  });

  app.get("/api/raw", async (request) => {
    const parsed = RawQuery.safeParse(request.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`Invalid query${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
    }
    const filter = parsed.data;
    const repo = appRepo(ctx);
    const result = await repo.readRaw();
    const q = filter.q?.toLowerCase();
    let items = result.rows.filter(
      (row) =>
        (filter.date === undefined || row.collected_at.slice(0, 10) === filter.date) &&
        (filter.source.length === 0 || filter.source.includes(row.source)) &&
        (!q || row.title.toLowerCase().includes(q) || row.snippet.toLowerCase().includes(q)),
    );
    let warnings = result.warnings;
    const ageS = result.ageS;
    const statuses = sortStatuses(ctx, items.map((item) => item.id));
    warnings += statuses.warnings;
    if (filter.status.length > 0) {
      items = items.filter((item) => {
        const status = statuses.byId.get(item.id);
        return status !== undefined && filter.status.includes(status);
      });
    }
    const total = items.length;
    const page = items
      .slice(filter.offset, filter.offset + filter.limit)
      .map((item) => ({ ...item, sort_status: statuses.byId.get(item.id) ?? null }));
    return RawResponse.parse({
      date: filter.date ?? null,
      items: page,
      total,
      warnings,
      cache: { age_s: ageS },
    });
  });

  app.get("/api/dates", async (request) => {
    const query = z.object({ scope: z.string().optional() }).safeParse(request.query);
    const scope = query.success && query.data.scope ? query.data.scope : "all";
    const result = await appRepo(ctx).readSorted({ onlyLatest: false });
    const dates = [...new Set(result.rows.filter((row) => (row.scope || "all") === scope).map((row) => row.run_date))].sort().reverse();
    return z.object({ dates: z.array(z.string()) }).parse({ dates });
  });
}

/** items_run sort_status join for /raw status[] (chunked IN queries). */
function sortStatuses(
  ctx: AppContext,
  ids: string[],
): { byId: Map<string, string>; warnings: number } {
  const byId = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = ctx.db
      .prepare(`SELECT id, sort_status FROM items_run WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string; sort_status: string }[];
    for (const row of rows) byId.set(row.id, row.sort_status);
  }
  return { byId, warnings: 0 };
}
