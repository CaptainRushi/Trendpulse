/**
 * Typed API client. Same-origin fetch; every non-2xx becomes an ApiError
 * carrying the envelope code/message/hint for UI rendering.
 */
export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
}

/** Doc 16 live graph contract (mirrors @trendpulse/shared Pulse* schemas). */
export interface PulseTopicSummary {
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

export interface PulseTodayTop {
  date: string;
  from_previous_day: boolean;
  topic: PulseTopicSummary | null;
  runner_ups: PulseTopicSummary[];
  live: {
    enabled: boolean;
    last_sample_at: string | null;
    next_sample_at: string | null;
    interval_min: number;
    status: "live" | "paused" | "stale";
  };
}

export interface PulsePoint {
  t: string;
  index: number;
  total: number;
}

export interface PulseSeries {
  topic_id: string;
  title: string;
  rank: number;
  has_live_metric: boolean;
  sources: string[];
  points: PulsePoint[];
}

export interface PulseSamples {
  date: string;
  baseline_at: string | null;
  series: PulseSeries[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string | undefined;
  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    if (body.error.hint !== undefined) this.hint = body.error.hint;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(0, { error: { code: "OFFLINE", message: "Cannot reach the server.", hint: "Is TrendPulse running on :4317?" } });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    throw new ApiError(res.status, {
      error: { code: "INTERNAL", message: `Unexpected response (HTTP ${String(res.status)}).` },
    });
  }
  if (!res.ok) {
    if (typeof body === "object" && body !== null && "error" in body) {
      throw new ApiError(res.status, body as ApiErrorBody);
    }
    throw new ApiError(res.status, {
      error: { code: "INTERNAL", message: `Request failed (HTTP ${String(res.status)}).` },
    });
  }
  return body as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  },
  put<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  },
};

/* ── resource shapes (mirror server zod records; UI reads, never writes) ── */

export interface SortedTopic {
  topic_id: string;
  run_id: string;
  run_date: string;
  rank: number;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  trend_score: number;
  score_engagement: number;
  score_diversity: number;
  score_relevance: number;
  score_novelty: number;
  momentum: string;
  sentiment: string;
  why_trending: string;
  content_angles: string[];
  evidence_item_ids: string[];
  source_count: number;
  top_urls: string[];
  jev_model: string;
  prompt_version: string;
  sorted_at: string;
  is_latest: boolean;
  hidden: boolean;
}

export interface RawItem {
  id: string;
  run_id: string;
  collected_at: string;
  source: string;
  source_item_id: string | null;
  url: string;
  title: string;
  snippet: string;
  author: string | null;
  published_at: string | null;
  engagement_score: number | null;
  engagement_extra: Record<string, number>;
  engagement_norm: number;
  language: string | null;
  region: string | null;
  content_hash: string;
  merged_sources: string[];
  extraction_model: string | null;
  sort_status: string | null;
}

export interface Digest {
  run_date: string;
  run_id: string;
  digest: string;
  top_topic_id: string;
  topics_count: number;
  items_count: number;
  sources_ok: number;
  sources_total: number;
  top_categories: { category: string; count: number }[];
  created_at: string;
  is_latest: boolean;
}

export interface SourceEntry {
  key: string;
  label: string;
  enabled: boolean;
  item_limit: number;
  config: Record<string, unknown>;
  requires: string[];
  last_status: string | null;
  last_error: string | null;
  last_run_at: string | null;
  last_items: number | null;
}

export interface RunRow {
  run_id: string;
  run_date: string;
  trigger: string;
  status: string;
  stages_requested: string[];
  started_at: string;
  finished_at: string | null;
  items_collected: number;
  items_new: number;
  topics_count: number;
  error: string | null;
}

export interface RunDetail {
  run: RunRow;
  stages: { stage: string; status: string; started_at: string | null; finished_at: string | null }[];
  source_stats: { source: string; status: string; items: number; duration_ms: number; error: string | null }[];
  llm: { calls: number; tokens_in: number; tokens_out: number };
}

export interface SettingView {
  value: unknown;
  is_set: boolean;
  secret: boolean;
  source: "env" | "settings" | "default";
}

export interface Health {
  ok: boolean;
  version: string;
  setup_complete: boolean;
  sheets: "ok" | "error";
  omniroute: "ok" | "error";
  jev: "ok" | "error";
  next_run_at: string | null;
  last_run: { run_id: string; run_date: string; status: string } | null;
}

export interface TrendsResponse {
  date: string;
  items: SortedTopic[];
  total: number;
  warnings: number;
  cache: { age_s: number };
}

export interface RawResponse {
  date: string | null;
  items: RawItem[];
  total: number;
  warnings: number;
  cache: { age_s: number };
}
