/**
 * Tab definitions + header rows — the single source of truth for columns.
 * Mirrors docs/05_BACKEND_SCHEMA.md §1. If the sheet and this file disagree,
 * this file wins and init() heals fresh tabs; human edits to data rows are
 * never overwritten (bad rows are skipped on read instead).
 */
import { z } from "zod";

export const RAW_TRENDS_TAB = "raw_trends";
export const SORTED_TRENDS_TAB = "sorted_trends";
export const DAILY_DIGEST_TAB = "daily_digest";
export const RUNS_LOG_TAB = "runs_log";

export const REQUIRED_TABS: readonly string[] = [
  RAW_TRENDS_TAB,
  SORTED_TRENDS_TAB,
  DAILY_DIGEST_TAB,
  RUNS_LOG_TAB,
];

export const RAW_TRENDS_HEADERS: readonly string[] = [
  "id",
  "run_id",
  "collected_at",
  "source",
  "source_item_id",
  "url",
  "title",
  "snippet",
  "author",
  "published_at",
  "engagement_score",
  "engagement_json",
  "engagement_norm",
  "language",
  "region",
  "content_hash",
  "merged_sources",
  "extraction_model",
];

export const SORTED_TRENDS_HEADERS: readonly string[] = [
  "topic_id",
  "run_id",
  "run_date",
  "rank",
  "title",
  "summary",
  "category",
  "tags",
  "trend_score",
  "score_engagement",
  "score_diversity",
  "score_relevance",
  "score_novelty",
  "momentum",
  "sentiment",
  "why_trending",
  "content_angles",
  "evidence_item_ids",
  "source_count",
  "top_urls",
  "jev_model",
  "prompt_version",
  "sorted_at",
  "is_latest",
  "hidden",
];

export const DAILY_DIGEST_HEADERS: readonly string[] = [
  "run_date",
  "run_id",
  "digest",
  "top_topic_id",
  "topics_count",
  "items_count",
  "sources_ok",
  "sources_total",
  "top_categories",
  "created_at",
  "is_latest",
];

export const RUNS_LOG_HEADERS: readonly string[] = [
  "run_id",
  "started_at",
  "finished_at",
  "trigger",
  "status",
  "stages_json",
  "source_stats_json",
  "items_collected",
  "items_new",
  "topics_count",
  "llm_calls",
  "tokens_in",
  "tokens_out",
  "errors_json",
  "app_version",
];

export const TAB_HEADERS: Record<string, readonly string[]> = {
  [RAW_TRENDS_TAB]: RAW_TRENDS_HEADERS,
  [SORTED_TRENDS_TAB]: SORTED_TRENDS_HEADERS,
  [DAILY_DIGEST_TAB]: DAILY_DIGEST_HEADERS,
  [RUNS_LOG_TAB]: RUNS_LOG_HEADERS,
};

/** Sheets API per-minute limits → writes are batched at most this large. */
export const MAX_APPEND_BATCH = 500;

// ── Record types (rich values; mappers stringify for the sheet) ─────────────

export const SourceKey = z.enum([
  "hackernews",
  "reddit",
  "google_trends",
  "github",
  "wikipedia",
  "rss",
  "webpage",
  "youtube",
  "producthunt",
  "devto",
]);

export const Category = z.enum([
  "Tech",
  "AI",
  "Business",
  "Finance",
  "Science",
  "Health",
  "Politics",
  "World",
  "Sports",
  "Entertainment",
  "Culture",
  "Gaming",
  "Lifestyle",
  "Other",
]);

export const Momentum = z.enum(["new", "rising", "peak", "steady", "fading"]);
export const Sentiment = z.enum(["positive", "neutral", "negative", "mixed"]);

export const RawTrendRecord = z.object({
  id: z.string(),
  run_id: z.string(),
  collected_at: z.string(),
  source: SourceKey,
  source_item_id: z.string().nullable(),
  url: z.string().url(),
  title: z.string(),
  snippet: z.string(),
  author: z.string().nullable(),
  published_at: z.string().nullable(),
  engagement_score: z.number().nullable(),
  engagement_extra: z.record(z.string(), z.number()),
  engagement_norm: z.number().min(0).max(1),
  language: z.string().nullable(),
  region: z.string().nullable(),
  content_hash: z.string(),
  merged_sources: z.array(z.string()),
  extraction_model: z.string().nullable(),
});
export type RawTrendRecord = z.infer<typeof RawTrendRecord>;

export const SortedTrendRecord = z.object({
  topic_id: z.string(),
  run_id: z.string(),
  run_date: z.string(),
  rank: z.number().int(),
  title: z.string(),
  summary: z.string(),
  category: Category,
  tags: z.array(z.string()),
  trend_score: z.number().int().min(0).max(100),
  score_engagement: z.number(),
  score_diversity: z.number(),
  score_relevance: z.number(),
  score_novelty: z.number(),
  momentum: Momentum,
  sentiment: Sentiment,
  why_trending: z.string(),
  content_angles: z.array(z.string()).min(1),
  evidence_item_ids: z.array(z.string()),
  source_count: z.number().int(),
  top_urls: z.array(z.string()),
  jev_model: z.string(),
  prompt_version: z.string(),
  sorted_at: z.string(),
  is_latest: z.boolean(),
  hidden: z.boolean(),
});
export type SortedTrendRecord = z.infer<typeof SortedTrendRecord>;

export const DigestRecord = z.object({
  run_date: z.string(),
  run_id: z.string(),
  digest: z.string(),
  top_topic_id: z.string(),
  topics_count: z.number().int(),
  items_count: z.number().int(),
  sources_ok: z.number().int(),
  sources_total: z.number().int(),
  top_categories: z.array(z.object({ category: z.string(), count: z.number().int() })),
  created_at: z.string(),
  is_latest: z.boolean(),
});
export type DigestRecord = z.infer<typeof DigestRecord>;

export const RunLogRecord = z.object({
  run_id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  stages: z.unknown(),
  source_stats: z.unknown(),
  items_collected: z.number().int(),
  items_new: z.number().int(),
  topics_count: z.number().int(),
  llm_calls: z.number().int(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  errors: z.unknown(),
  app_version: z.string(),
});
export type RunLogRecord = z.infer<typeof RunLogRecord>;
