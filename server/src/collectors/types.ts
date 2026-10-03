/**
 * Collector contracts (TRD §4.1). Collectors return *drafts* — pre-normalize
 * items. Canonical URL, content_hash, engagement_norm, language detection and
 * dedupe happen in Phase 4 (normalize stage).
 */
import { z } from "zod";
import type { Logger } from "pino";
import { SourceKey } from "../sheets/schema.js";
import type { HttpClient } from "./http.js";
import type { LlmExtractor } from "../llm/extract.js";
import type { ScraplingClient } from "../scraping/client.js";

export const RawItemDraft = z.object({
  source: SourceKey,
  /** id in the source, if any. */
  source_item_id: z.string().nullable().default(null),
  /** Source URL as-is; canonicalization happens in normalize. */
  url: z.string().min(1),
  title: z.string().min(1),
  snippet: z.string().default(""),
  author: z.string().nullable().default(null),
  /** ISO 8601 when the source provides one, else null. */
  published_at: z.string().datetime({ offset: true }).nullable().default(null),
  /** Primary raw number: points, upvotes, views, stars. */
  engagement_score: z.number().nonnegative().nullable().default(null),
  /** Extra signals, e.g. { comments: 210, forks: 12 }. */
  engagement: z.record(z.string(), z.number()).default({}),
  language: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  /** Set when LLM extraction produced the fields (webpage). */
  extraction_model: z.string().nullable().default(null),
});
export type RawItemDraft = z.infer<typeof RawItemDraft>;
/** What collectors pass to `RawItemDraft.parse` — defaults fill the gaps. */
export type RawItemDraftInput = z.input<typeof RawItemDraft>;

export const SourceStats = z.object({
  source: SourceKey,
  /** blocked = access-walled (403/429), distinct from error: retrying is pointless. */
  status: z.enum(["ok", "error", "blocked", "skipped"]),
  items: z.number().int().min(0),
  duration_ms: z.number().int().min(0),
  error: z.string().nullable().default(null),
});
export type SourceStats = z.infer<typeof SourceStats>;

/** Per-source config from SQLite `sources.config_json` (subreddits, feed urls, page urls). */
export type SourceConfig = Record<string, unknown>;

export interface CollectContext {
  runId: string;
  /** Resolved limit: sources.item_limit override → MAX_ITEMS_PER_SOURCE. */
  limit: number;
  niches: string[];
  geo: string;
  /** From loadConfig().enablePlaywright — JS-render fallback flag. */
  enablePlaywright: boolean;
  http: HttpClient;
  llm: LlmExtractor;
  /** Sidecar client when the supervisor is up (webpage collector only). */
  scraping?: ScraplingClient | null;
  signal: AbortSignal;
  log: Logger;
  /** This source's config_json (validated per collector). */
  config: SourceConfig;
}

export interface CollectResult {
  items: RawItemDraft[];
  stats: SourceStats;
}

export interface Collector {
  key: SourceKey;
  label: string;
  /** Env vars or config needed for this collector to run (doctor/wizard display). */
  requires: string[];
  collect(ctx: CollectContext): Promise<CollectResult>;
  /** Cheap reachability check for `doctor` (never throws). */
  ping?(ctx: CollectContext): Promise<PingResult>;
}

/** Doctor ping: cheap reachability check, never throws. */
export interface PingResult {
  ok: boolean;
  detail: string;
}
