/**
 * Day-1 REST contract (docs/12 §7). Frontend codes against this file;
 * server validates every route against the same zod schemas.
 * SSE (`/runs/:id/stream`) is event text, not JSON — event names only here.
 */
import { z } from "zod";
import { Category, Momentum, SortedTopic, SourceKey } from "./domain.js";

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    hint: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const ServiceState = z.enum(["ok", "error", "unknown"]);
export type ServiceState = z.infer<typeof ServiceState>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  setup_complete: z.boolean(),
  sheets: ServiceState,
  omniroute: ServiceState,
  jev: ServiceState,
  next_run_at: z.string().nullable(),
  last_run: z
    .object({ run_id: z.string(), run_date: z.string(), status: z.string() })
    .nullable(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean);
  });

export const TrendsQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.array(Category).optional(),
  source: z.array(SourceKey).optional(),
  momentum: z.array(Momentum).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["score", "rank", "title"]).default("score"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Raw query strings arrive as comma-joined values; normalize before use.
  raw_category: csvList,
  raw_source: csvList,
  raw_momentum: csvList,
});
export type TrendsQuery = z.infer<typeof TrendsQuery>;

export const TrendsResponse = z.object({
  date: z.string(),
  items: z.array(SortedTopic),
  total: z.number().int().min(0),
  warnings: z.array(z.string()).default([]),
  cache: z.object({ age_s: z.number().min(0) }),
});
export type TrendsResponse = z.infer<typeof TrendsResponse>;

export const TopicDetailResponse = SortedTopic.extend({
  evidence: z.array(z.unknown()).default([]),
});
export type TopicDetailResponse = z.infer<typeof TopicDetailResponse>;

export const DigestResponse = z.object({
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
export type DigestResponse = z.infer<typeof DigestResponse>;

export const DatesResponse = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});
export type DatesResponse = z.infer<typeof DatesResponse>;

export const RawQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.array(SourceKey).optional(),
  status: z.array(z.enum(["pending", "sorted", "discarded", "sort_failed"])).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RawQuery = z.infer<typeof RawQuery>;

export const SourceEntry = z.object({
  key: SourceKey,
  enabled: z.boolean(),
  item_limit: z.number().int().min(1),
  config: z.record(z.unknown()).default({}),
});
export type SourceEntry = z.infer<typeof SourceEntry>;

export const UpdateSourceBody = z.object({
  enabled: z.boolean().optional(),
  item_limit: z.number().int().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdateSourceBody = z.infer<typeof UpdateSourceBody>;

export const CreateRunBody = z.object({
  stages: z.array(z.string()).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sources: z.array(SourceKey).optional(),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const CreateRunResponse = z.object({ run_id: z.string() });
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const SettingView = z.object({
  value: z.unknown(),
  is_set: z.boolean(),
  secret: z.boolean(),
  source: z.enum(["env", "settings", "default"]),
});
export type SettingView = z.infer<typeof SettingView>;

export const SettingsResponse = z.record(SettingView);
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const UpdateSettingsBody = z.record(z.unknown());
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBody>;

export const TestSheetsBody = z.object({
  sheet_id: z.string().optional(),
  service_account_json: z.string().optional(),
});
export type TestSheetsBody = z.infer<typeof TestSheetsBody>;

export const TestOmnirouteBody = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
});
export type TestOmnirouteBody = z.infer<typeof TestOmnirouteBody>;

export const TestJevBody = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
});
export type TestJevBody = z.infer<typeof TestJevBody>;

export const TestResult = z.object({
  ok: z.boolean(),
  latency_ms: z.number().optional(),
  models: z.array(z.string()).optional(),
  choice: z.string().optional(),
  confidence: z.number().optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
});
export type TestResult = z.infer<typeof TestResult>;

export const SheetsLinkResponse = z.object({
  spreadsheet_url: z.string(),
  tabs: z.object({ raw_trends: z.string(), sorted_trends: z.string() }),
});
export type SheetsLinkResponse = z.infer<typeof SheetsLinkResponse>;

export const JevHealthResponse = z.object({
  key_present: z.boolean(),
  last_call_ok: z.boolean().nullable(),
  price_per_m_input: z.number(),
  budget_used_usd: z.number(),
  budget_usd: z.number(),
});
export type JevHealthResponse = z.infer<typeof JevHealthResponse>;

/** SSE event names for `GET /api/runs/:id/stream` (heartbeat is a comment). */
export const RunStreamEvents = z.enum(["stage", "source", "progress", "log", "done", "error"]);
export type RunStreamEvents = z.infer<typeof RunStreamEvents>;

/** Doc 16 live graph contract. */

export const PulseTopicSummary = z.object({
  topic_id: z.string(),
  rank: z.number(),
  title: z.string(),
  summary: z.string(),
  why_trending: z.string(),
  first_angle: z.string(),
  category: z.string(),
  momentum: z.string(),
  score: z.number(),
  source_count: z.number(),
  items_count: z.number(),
  has_live_metric: z.boolean(),
});
export type PulseTopicSummary = z.infer<typeof PulseTopicSummary>;

export const PulseTodayTop = z.object({
  date: z.string(),
  scope: z.string().default("all"),
  hint: z.string().optional(),
  from_previous_day: z.boolean(),
  topic: PulseTopicSummary.nullable(),
  runner_ups: z.array(PulseTopicSummary),
  live: z.object({
    enabled: z.boolean(),
    last_sample_at: z.string().nullable(),
    next_sample_at: z.string().nullable(),
    interval_min: z.number(),
    status: z.enum(["live", "paused", "stale"]),
  }),
});
export type PulseTodayTop = z.infer<typeof PulseTodayTop>;

export const PulsePoint = z.object({ t: z.string(), index: z.number(), total: z.number() });
export type PulsePoint = z.infer<typeof PulsePoint>;

export const PulseSeries = z.object({
  topic_id: z.string(),
  title: z.string(),
  rank: z.number(),
  has_live_metric: z.boolean(),
  sources: z.array(z.string()),
  points: z.array(PulsePoint),
});
export type PulseSeries = z.infer<typeof PulseSeries>;

export const PulseSamples = z.object({
  date: z.string(),
  scope: z.string().default("all"),
  baseline_at: z.string().nullable(),
  series: z.array(PulseSeries),
});
export type PulseSamples = z.infer<typeof PulseSamples>;

/** SSE event names for `GET /api/live/stream` (heartbeat is a comment). */
export const LiveStreamEvents = z.enum(["sample", "top_changed", "cycle"]);
export type LiveStreamEvents = z.infer<typeof LiveStreamEvents>;

/** Every Day-1 route path (used by W-10: client calls must hit this set). */
export const Day1Routes = [
  "GET /api/health",
  "GET /api/trends",
  "GET /api/trends/:topic_id",
  "GET /api/digest",
  "GET /api/raw",
  "GET /api/dates",
  "GET /api/sources",
  "PUT /api/sources/:key",
  "GET /api/runs",
  "GET /api/runs/:id",
  "POST /api/runs",
  "POST /api/runs/:id/retry",
  "GET /api/runs/:id/stream",
  "GET /api/settings",
  "PUT /api/settings",
  "POST /api/setup/test-sheets",
  "POST /api/setup/test-omniroute",
  "POST /api/setup/test-jev",
  "POST /api/sheets/init",
  "POST /api/sheets/sync",
  "GET /api/sheets/link",
  "GET /api/export/topics.csv",
  "GET /api/jev/health",
  "GET /api/today/top",
  "GET /api/live/samples",
  "GET /api/live/stream",
  "POST /api/live/sample-now",
] as const;
