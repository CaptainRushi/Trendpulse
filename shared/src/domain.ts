/**
 * Day-1 domain contract (docs/12 Prompt 1 task 6).
 * Amendments vs docs/05 §3: momentum has no `fading` today;
 * JevTopic/JevMapOutput replaced by ItemLabels (Jev answers) +
 * TopicText/WriterOutput (OmniRoute writer text). RawItem gains
 * `source_label` and the Day-1 source enum (webpage/recipe included,
 * youtube/producthunt/devto arrive later).
 */
import { z } from "zod";

export const SourceKey = z.enum([
  "hackernews",
  "reddit",
  "google_trends",
  "github",
  "wikipedia",
  "rss",
  "webpage",
  "recipe",
]);
export type SourceKey = z.infer<typeof SourceKey>;

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
export type Category = z.infer<typeof Category>;

/** No `fading` today — it needs topic history (docs/11 §1.3 backlog). */
export const Momentum = z.enum(["new", "rising", "peak", "steady"]);
export type Momentum = z.infer<typeof Momentum>;

export const Sentiment = z.enum(["positive", "neutral", "negative", "mixed"]);
export type Sentiment = z.infer<typeof Sentiment>;

/** One Jev classification answer set for an item (typed, never prose). */
export const ItemLabels = z.object({
  category: Category,
  category_confidence: z.number().min(0).max(1),
  quality: z.number().min(0).max(1),
  niche_fit: z.number().min(0).max(1).nullable(),
  novelty: z.number().min(0).max(1),
  sentiment: Sentiment,
  classifier: z.enum(["jev", "fallback"]),
  flags: z.array(z.string()).default([]),
});
export type ItemLabels = z.infer<typeof ItemLabels>;

/** One writer card for a cluster — text generation only, ids verified in code. */
export const TopicText = z.object({
  cluster_id: z.string().min(1),
  title: z.string().min(1).max(140),
  summary: z.string().min(1).max(280),
  why_trending: z.string().min(1).max(200),
  tags: z.array(z.string()).max(6),
  content_angles: z.array(z.string()).length(3),
});
export type TopicText = z.infer<typeof TopicText>;

export const WriterOutput = z.object({
  topics: z.array(TopicText),
});
export type WriterOutput = z.infer<typeof WriterOutput>;

export const ScoreParts = z.object({
  engagement: z.number().min(0).max(1),
  diversity: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
});
export type ScoreParts = z.infer<typeof ScoreParts>;

export const RawItem = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  collected_at: z.string().datetime(),
  source: SourceKey,
  source_label: z.string().nullable().default(null),
  source_item_id: z.string().nullable(),
  url: z.string().url(),
  title: z.string().min(1).max(300),
  snippet: z.string().max(500).default(""),
  author: z.string().nullable(),
  published_at: z.string().datetime().nullable(),
  engagement_score: z.number().nonnegative().nullable(),
  engagement: z.record(z.number()).default({}),
  engagement_norm: z.number().min(0).max(1),
  language: z.string().nullable(),
  region: z.string().nullable(),
  content_hash: z.string().min(1),
  merged_sources: z.array(SourceKey).default([]),
  extraction_model: z.string().nullable(),
});
export type RawItem = z.infer<typeof RawItem>;

/** Persisted ranked topic: writer text + code-computed classification/score. */
export const SortedTopic = TopicText.extend({
  topic_id: z.string().min(1),
  run_id: z.string().min(1),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rank: z.number().int().min(1),
  category: Category,
  sentiment: Sentiment,
  momentum: Momentum,
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  trend_score: z.number().int().min(0).max(100),
  score_parts: ScoreParts,
  source_count: z.number().int().min(1),
  top_urls: z.array(z.string().url()).max(5),
  evidence_item_ids: z.array(z.string()).min(1),
  models: z.object({
    jev_model: z.string(),
    writer_model: z.string(),
  }),
  prompt_version: z.string().min(1),
  sorted_at: z.string().datetime(),
  is_latest: z.boolean(),
  hidden: z.boolean(),
});
export type SortedTopic = z.infer<typeof SortedTopic>;
