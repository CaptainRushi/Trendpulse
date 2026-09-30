/**
 * Record ⇄ sheet-row mappers. Sheets stores everything as display strings,
 * so numbers/booleans/JSON are stringified on write and strictly re-parsed
 * on read. Any cell that fails validation throws RowParseError and the repo
 * skips that row (counted as a warning) instead of failing the whole read.
 */
import { z } from "zod";
import {
  DigestRecord,
  RawTrendRecord,
  RunLogRecord,
  SortedTrendRecord,
} from "./schema.js";
import type {
  DigestRecord as Digest,
  RawTrendRecord as Raw,
  RunLogRecord as RunLog,
  SortedTrendRecord as Sorted,
} from "./schema.js";

export class RowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowParseError";
  }
}

/** Cells may arrive as strings (RAW) or numbers/booleans (UNFORMATTED_VALUE). */
type Cell = unknown;

function cellAt(cells: Cell[], index: number): Cell {
  return index < cells.length ? cells[index] : undefined;
}

function text(cell: Cell, field: string): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") {
    return String(cell);
  }
  throw new RowParseError(`field ${field}: expected text cell`);
}

function nullableText(cell: Cell, field: string): string | null {
  const s = text(cell, field);
  return s === "" ? null : s;
}

function numOrNull(cell: Cell, field: string): number | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell !== "string" && typeof cell !== "number") {
    throw new RowParseError(`field ${field}: expected numeric cell`);
  }
  const n = typeof cell === "number" ? cell : Number(cell);
  if (!Number.isFinite(n)) throw new RowParseError(`field ${field}: not a number`);
  return n;
}

function num(cell: Cell, field: string): number {
  const n = numOrNull(cell, field);
  if (n === null) throw new RowParseError(`field ${field}: required number is empty`);
  return n;
}

function int(cell: Cell, field: string): number {
  const n = num(cell, field);
  if (!Number.isInteger(n)) throw new RowParseError(`field ${field}: not an integer`);
  return n;
}

function norm(cell: Cell, field: string): number {
  const n = num(cell, field);
  if (n < 0 || n > 1) throw new RowParseError(`field ${field}: expected 0..1`);
  return n;
}

/** Accepts TRUE/true/1 (and FALSE/false/0/"") — Sheets renders bools loosely. */
function bool(cell: Cell, field: string): boolean {
  if (cell === true || cell === 1) return true;
  if (cell === false || cell === 0 || cell === null || cell === undefined) return false;
  if (typeof cell !== "string" && typeof cell !== "number") {
    throw new RowParseError(`field ${field}: not a boolean`);
  }
  const s = String(cell).trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0" || s === "") return false;
  throw new RowParseError(`field ${field}: not a boolean`);
}

/**
 * Empty cell → the caller's default (absent, not broken); non-empty garbage →
 * RowParseError. Rationale: humans blank cells by accident, but a cell with
 * content that isn't JSON is genuinely corrupt. Uniform rule, documented.
 */
function json<T>(cell: Cell, field: string, schema: z.ZodType<T>, emptyDefault: T): T {
  const s = text(cell, field);
  if (s === "") return emptyDefault;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s) as unknown;
  } catch {
    throw new RowParseError(`field ${field}: corrupt JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new RowParseError(
      `field ${field}: invalid JSON shape (${result.error.issues[0]?.message ?? "invalid value"})`,
    );
  }
  return result.data;
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RowParseError(
      `row failed validation: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown"}`,
    );
  }
  return result.data;
}

const opt = (s: string | null): string => s ?? "";
const req = (s: string): string => s;

// ── raw_trends (18 cols) ─────────────────────────────────────────────────────

export function rawRecordToRow(r: Raw): string[] {
  return [
    req(r.id),
    req(r.run_id),
    req(r.collected_at),
    req(r.source),
    opt(r.source_item_id),
    req(r.url),
    req(r.title),
    req(r.snippet),
    opt(r.author),
    opt(r.published_at),
    r.engagement_score === null ? "" : String(r.engagement_score),
    JSON.stringify(r.engagement_extra),
    String(r.engagement_norm),
    opt(r.language),
    opt(r.region),
    req(r.content_hash),
    JSON.stringify(r.merged_sources),
    opt(r.extraction_model),
  ];
}

export function rowToRawRecord(cells: Cell[]): Raw {
  return parseWith(
    RawTrendRecord,
    {
      id: text(cellAt(cells, 0), "id"),
      run_id: text(cellAt(cells, 1), "run_id"),
      collected_at: text(cellAt(cells, 2), "collected_at"),
      source: text(cellAt(cells, 3), "source"),
      source_item_id: nullableText(cellAt(cells, 4), "source_item_id"),
      url: text(cellAt(cells, 5), "url"),
      title: text(cellAt(cells, 6), "title"),
      snippet: text(cellAt(cells, 7), "snippet"),
      author: nullableText(cellAt(cells, 8), "author"),
      published_at: nullableText(cellAt(cells, 9), "published_at"),
      engagement_score: numOrNull(cellAt(cells, 10), "engagement_score"),
      engagement_extra: json(cellAt(cells, 11), "engagement_json", z.record(z.string(), z.number()), {}),
      engagement_norm: norm(cellAt(cells, 12), "engagement_norm"),
      language: nullableText(cellAt(cells, 13), "language"),
      region: nullableText(cellAt(cells, 14), "region"),
      content_hash: text(cellAt(cells, 15), "content_hash"),
      merged_sources: json(cellAt(cells, 16), "merged_sources", z.array(z.string()), []),
      extraction_model: nullableText(cellAt(cells, 17), "extraction_model"),
    },
  );
}

// ── sorted_trends (25 cols) ──────────────────────────────────────────────────

export function sortedRecordToRow(r: Sorted): string[] {
  return [
    req(r.topic_id),
    req(r.run_id),
    req(r.run_date),
    String(r.rank),
    req(r.title),
    req(r.summary),
    req(r.category),
    JSON.stringify(r.tags),
    String(r.trend_score),
    String(r.score_engagement),
    String(r.score_diversity),
    String(r.score_relevance),
    String(r.score_novelty),
    req(r.momentum),
    req(r.sentiment),
    req(r.why_trending),
    JSON.stringify(r.content_angles),
    JSON.stringify(r.evidence_item_ids),
    String(r.source_count),
    JSON.stringify(r.top_urls),
    req(r.jev_model),
    req(r.prompt_version),
    req(r.sorted_at),
    r.is_latest ? "TRUE" : "FALSE",
    r.hidden ? "TRUE" : "FALSE",
  ];
}

export function rowToSortedRecord(cells: Cell[]): Sorted {
  return parseWith(
    SortedTrendRecord,
    {
      topic_id: text(cellAt(cells, 0), "topic_id"),
      run_id: text(cellAt(cells, 1), "run_id"),
      run_date: text(cellAt(cells, 2), "run_date"),
      rank: int(cellAt(cells, 3), "rank"),
      title: text(cellAt(cells, 4), "title"),
      summary: text(cellAt(cells, 5), "summary"),
      category: text(cellAt(cells, 6), "category"),
      tags: json(cellAt(cells, 7), "tags", z.array(z.string()), []),
      trend_score: int(cellAt(cells, 8), "trend_score"),
      score_engagement: num(cellAt(cells, 9), "score_engagement"),
      score_diversity: num(cellAt(cells, 10), "score_diversity"),
      score_relevance: num(cellAt(cells, 11), "score_relevance"),
      score_novelty: num(cellAt(cells, 12), "score_novelty"),
      momentum: text(cellAt(cells, 13), "momentum"),
      sentiment: text(cellAt(cells, 14), "sentiment"),
      why_trending: text(cellAt(cells, 15), "why_trending"),
      content_angles: json(cellAt(cells, 16), "content_angles", z.array(z.string()), []),
      evidence_item_ids: json(cellAt(cells, 17), "evidence_item_ids", z.array(z.string()), []),
      source_count: int(cellAt(cells, 18), "source_count"),
      top_urls: json(cellAt(cells, 19), "top_urls", z.array(z.string()), []),
      jev_model: text(cellAt(cells, 20), "jev_model"),
      prompt_version: text(cellAt(cells, 21), "prompt_version"),
      sorted_at: text(cellAt(cells, 22), "sorted_at"),
      is_latest: bool(cellAt(cells, 23), "is_latest"),
      hidden: bool(cellAt(cells, 24), "hidden"),
    },
  );
}

// ── daily_digest (11 cols) ───────────────────────────────────────────────────

export function digestRecordToRow(r: Digest): string[] {
  return [
    req(r.run_date),
    req(r.run_id),
    req(r.digest),
    req(r.top_topic_id),
    String(r.topics_count),
    String(r.items_count),
    String(r.sources_ok),
    String(r.sources_total),
    JSON.stringify(r.top_categories),
    req(r.created_at),
    r.is_latest ? "TRUE" : "FALSE",
  ];
}

export function rowToDigestRecord(cells: Cell[]): Digest {
  return parseWith(
    DigestRecord,
    {
      run_date: text(cellAt(cells, 0), "run_date"),
      run_id: text(cellAt(cells, 1), "run_id"),
      digest: text(cellAt(cells, 2), "digest"),
      top_topic_id: text(cellAt(cells, 3), "top_topic_id"),
      topics_count: int(cellAt(cells, 4), "topics_count"),
      items_count: int(cellAt(cells, 5), "items_count"),
      sources_ok: int(cellAt(cells, 6), "sources_ok"),
      sources_total: int(cellAt(cells, 7), "sources_total"),
      top_categories: json(
        cellAt(cells, 8),
        "top_categories",
        z.array(z.object({ category: z.string(), count: z.number().int() })),
        [],
      ),
      created_at: text(cellAt(cells, 9), "created_at"),
      is_latest: bool(cellAt(cells, 10), "is_latest"),
    },
  );
}

// ── runs_log (15 cols) ───────────────────────────────────────────────────────

export function runLogRecordToRow(r: RunLog): string[] {
  return [
    req(r.run_id),
    req(r.started_at),
    opt(r.finished_at),
    req(r.trigger),
    req(r.status),
    JSON.stringify(r.stages),
    JSON.stringify(r.source_stats),
    String(r.items_collected),
    String(r.items_new),
    String(r.topics_count),
    String(r.llm_calls),
    String(r.tokens_in),
    String(r.tokens_out),
    JSON.stringify(r.errors),
    req(r.app_version),
  ];
}

export function rowToRunLogRecord(cells: Cell[]): RunLog {
  return parseWith(
    RunLogRecord,
    {
      run_id: text(cellAt(cells, 0), "run_id"),
      started_at: text(cellAt(cells, 1), "started_at"),
      finished_at: nullableText(cellAt(cells, 2), "finished_at"),
      trigger: text(cellAt(cells, 3), "trigger"),
      status: text(cellAt(cells, 4), "status"),
      stages: json(cellAt(cells, 5), "stages_json", z.unknown(), []),
      source_stats: json(cellAt(cells, 6), "source_stats_json", z.unknown(), {}),
      items_collected: int(cellAt(cells, 7), "items_collected"),
      items_new: int(cellAt(cells, 8), "items_new"),
      topics_count: int(cellAt(cells, 9), "topics_count"),
      llm_calls: int(cellAt(cells, 10), "llm_calls"),
      tokens_in: int(cellAt(cells, 11), "tokens_in"),
      tokens_out: int(cellAt(cells, 12), "tokens_out"),
      errors: json(cellAt(cells, 13), "errors_json", z.unknown(), []),
      app_version: text(cellAt(cells, 14), "app_version"),
    },
  );
}
