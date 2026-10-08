/**
 * Topic index (Doc 16 G1): persist_sorted writes one row per topic, flips the
 * previous latest set for the date, and stores baseline samples (index 100)
 * for the top-N topics that have refreshable items. Pure SQLite + selection
 * helpers for the API layer.
 */
import type { StateDb } from "../db/sqlite.js";
import { isRefreshableSource, type RefreshItem } from "./refresh.js";

/** Minimal topic shape for indexing (SortedTrendRecord satisfies this). */
export interface IndexableTopic {
  topic_id: string;
  rank: number;
  title: string;
  trend_score: number;
  source_count: number;
  hidden: boolean;
  evidence_item_ids: string[];
  /** Jev category label (e.g. "AI"); absent (tests/seeds) groups as Other. */
  category?: string;
}

export interface IndexedTopic {
  topicId: string;
  runId: string;
  runDate: string;
  rank: number;
  title: string;
  score: number;
  evidenceIds: string[];
  isLatest: boolean;
}

interface ItemBaseline {
  itemId: string;
  source: string;
  url: string;
  sourceItemId: string;
  baseline: number;
}

function parsePayload(json: string): { url: string; engagement: number; sourceItemId: string } {
  try {
    const parsed = JSON.parse(json) as { url?: unknown; engagement_score?: unknown; source_item_id?: unknown };
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      engagement: typeof parsed.engagement_score === "number" ? parsed.engagement_score : 0,
      sourceItemId: typeof parsed.source_item_id === "string" ? parsed.source_item_id : "",
    };
  } catch {
    return { url: "", engagement: 0, sourceItemId: "" };
  }
}

/** Baselines for one run date: item id → source/url/engagement at persist. */
export function readBaselines(db: StateDb, runDate: string): Map<string, ItemBaseline> {
  const rows = db
    .prepare("SELECT id, source, payload_json FROM items_run WHERE run_date = ?")
    .all(runDate) as { id: string; source: string; payload_json: string }[];
  const out = new Map<string, ItemBaseline>();
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    out.set(row.id, { itemId: row.id, source: row.source, url: payload.url, sourceItemId: payload.sourceItemId, baseline: payload.engagement });
  }
  return out;
}

/** Refreshable evidence items for a topic, best baseline first, at most 3. */
export function pickSampledItems(evidenceIds: string[], baselines: Map<string, ItemBaseline>): RefreshItem[] {
  return evidenceIds
    .map((id) => baselines.get(id))
    .filter((b): b is ItemBaseline => !!b && isRefreshableSource(b.source))
    .sort((a, b) => b.baseline - a.baseline)
    .slice(0, 3)
    .map((b) => ({ itemId: b.itemId, source: b.source, url: b.url, sourceItemId: b.sourceItemId, baseline: b.baseline, lastValue: b.baseline }));
}

export interface WriteSetResult {
  indexed: number;
  baselined: number;
  topChanged: boolean;
}

export function writeLatestSet(
  db: StateDb,
  runId: string,
  runDate: string,
  topics: IndexableTopic[],
  topN: number,
  sampledAt: string = new Date().toISOString(),
): WriteSetResult {
  // Doc 19: one latest set per (run_date, category). The previous overall
  // top (highest score among latest rows) decides topChanged.
  const previous = db
    .prepare("SELECT topic_id FROM topic_index WHERE run_date = ? AND is_latest = 1 ORDER BY score DESC LIMIT 1")
    .get(runDate) as { topic_id: string } | undefined;
  const byCategory = new Map<string, IndexableTopic[]>();
  for (const topic of topics) {
    const category = topic.category ?? "Other";
    const list = byCategory.get(category) ?? [];
    list.push(topic);
    byCategory.set(category, list);
  }
  const flip = db.prepare("UPDATE topic_index SET is_latest = 0 WHERE run_date = ? AND category = ? AND run_id <> ?");
  for (const category of byCategory.keys()) {
    flip.run(runDate, category, runId);
  }
  const insertTopic = db.prepare(
    "INSERT INTO topic_index (topic_id, run_id, run_date, rank, title, score, evidence_item_ids_json, created_at, is_latest, category) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) " +
      "ON CONFLICT(topic_id) DO UPDATE SET run_id = excluded.run_id, run_date = excluded.run_date, " +
      "rank = excluded.rank, title = excluded.title, score = excluded.score, " +
      "evidence_item_ids_json = excluded.evidence_item_ids_json, is_latest = 1, category = excluded.category",
  );
  const insertSample = db.prepare(
    "INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) " +
      "VALUES (?, ?, 100, ?, ?, 0, ?) ON CONFLICT(topic_id, sampled_at) DO NOTHING",
  );
  const baselines = readBaselines(db, runDate);
  const ranked = sortVisible(topics);
  let baselined = 0;
  ranked.forEach((topic, i) => {
    insertTopic.run(topic.topic_id, runId, runDate, topic.rank, topic.title, topic.trend_score, JSON.stringify(topic.evidence_item_ids), sampledAt, topic.category ?? "Other");
    // Top-N overall plus every category's rank 1, so each panel's chart
    // topic gets sampled on the next cycle.
    if (i < topN || topic.rank === 1) {
      const items = pickSampledItems(topic.evidence_item_ids, baselines);
      if (items.length > 0) {
        const total = items.reduce((sum, item) => sum + item.baseline, 0);
        if (total > 0) {
          insertSample.run(topic.topic_id, sampledAt, total, items.length, JSON.stringify(items.map((item) => ({ item_id: item.itemId, source: item.source, baseline: item.baseline }))));
          baselined += 1;
        }
      }
    }
  });
  // Overall top = highest score (ranks restart at 1 per category now).
  const next = [...ranked].sort((a, b) => b.trend_score - a.trend_score)[0]?.topic_id ?? "";
  return { indexed: ranked.length, baselined, topChanged: next !== "" && next !== (previous?.topic_id ?? "") };
}

function toIndexed(row: {
  topic_id: string;
  run_id: string;
  run_date: string;
  rank: number;
  title: string;
  score: number;
  evidence_item_ids_json: string;
  is_latest: number;
}): IndexedTopic {
  let evidenceIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.evidence_item_ids_json);
    if (Array.isArray(parsed)) evidenceIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    evidenceIds = [];
  }
  return {
    topicId: row.topic_id,
    runId: row.run_id,
    runDate: row.run_date,
    rank: row.rank,
    title: row.title,
    score: row.score,
    evidenceIds,
    isLatest: row.is_latest === 1,
  };
}

function sortVisible(topics: IndexableTopic[]): IndexableTopic[] {
  return [...topics]
    .filter((t) => !t.hidden)
    .sort((a, b) => a.rank - b.rank || b.trend_score - a.trend_score || b.source_count - a.source_count);
}

/** Rank 1 of the visible set (PULSE-03 selection). */
export function selectTop(topics: IndexableTopic[]): IndexableTopic | null {
  return sortVisible(topics)[0] ?? null;
}

/** Latest set for a date (rank order), or [] when never indexed. */
export function latestSet(db: StateDb, runDate: string, scope = "all"): IndexedTopic[] {
  const rows = db
    .prepare("SELECT * FROM topic_index WHERE run_date = ? AND scope_key = ? AND is_latest = 1 ORDER BY rank")
    .all(runDate, scope) as Parameters<typeof toIndexed>[0][];
  return rows.map(toIndexed);
}

/** Latest set for one Jev category label (Doc 19), rank order, at most `limit`. */
export function latestSetForCategory(db: StateDb, runDate: string, category: string, limit: number): IndexedTopic[] {
  const rows = db
    .prepare("SELECT * FROM topic_index WHERE run_date = ? AND category = ? AND is_latest = 1 ORDER BY rank LIMIT ?")
    .all(runDate, category, limit) as Parameters<typeof toIndexed>[0][];
  return rows.map(toIndexed);
}

/** True when the topic has any sample (baseline or later) from this date. */
export function hasSamples(db: StateDb, topicId: string, runDate: string): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM topic_samples WHERE topic_id = ? AND sampled_at >= ? AND sampled_at < ? LIMIT 1")
    .get(topicId, `${runDate}T00:00:00`, `${runDate}\uffff`) as { one: number } | undefined;
  return !!row;
}

/** Latest sample timestamp across a date's topics, or null. */
export function lastSampleAt(db: StateDb, runDate: string): string | null {
  const row = db
    .prepare("SELECT MAX(sampled_at) AS at FROM topic_samples WHERE sampled_at >= ? AND sampled_at < ?")
    .get(`${runDate}T00:00:00`, `${runDate}\uffff`) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** Most recent date with any indexed set (optionally for one scope), or null. */
export function mostRecentDate(db: StateDb, scope?: string): string | null {
  const row = (
    scope === undefined
      ? db.prepare("SELECT run_date FROM topic_index ORDER BY run_date DESC LIMIT 1").get()
      : db.prepare("SELECT run_date FROM topic_index WHERE scope_key = ? ORDER BY run_date DESC LIMIT 1").get(scope)
  ) as { run_date: string } | undefined;
  return row?.run_date ?? null;
}
