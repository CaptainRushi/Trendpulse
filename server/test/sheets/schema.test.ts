import { describe, expect, it } from "vitest";
import {
  DAILY_DIGEST_HEADERS,
  DAILY_DIGEST_TAB,
  MAX_APPEND_BATCH,
  RAW_TRENDS_HEADERS,
  RAW_TRENDS_TAB,
  REQUIRED_TABS,
  RUNS_LOG_HEADERS,
  RUNS_LOG_TAB,
  SORTED_TRENDS_HEADERS,
  SORTED_TRENDS_TAB,
  TAB_HEADERS,
  DigestRecord,
  RawTrendRecord,
  RunLogRecord,
  SortedTrendRecord,
} from "../../src/sheets/schema.js";

describe("tab definitions (single source of truth for columns)", () => {
  it("declares the four content tabs from 05_BACKEND_SCHEMA.md", () => {
    expect(REQUIRED_TABS).toEqual(["raw_trends", "sorted_trends", "daily_digest", "runs_log"]);
    expect(RAW_TRENDS_TAB).toBe("raw_trends");
    expect(SORTED_TRENDS_TAB).toBe("sorted_trends");
    expect(DAILY_DIGEST_TAB).toBe("daily_digest");
    expect(RUNS_LOG_TAB).toBe("runs_log");
  });

  it("raw_trends has the 19 spec columns in order (S = source_label)", () => {
    expect([...RAW_TRENDS_HEADERS]).toEqual([
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
      "source_label",
    ]);
  });

  it("sorted_trends has the 25 spec columns in order", () => {
    expect(SORTED_TRENDS_HEADERS).toHaveLength(25);
    expect(SORTED_TRENDS_HEADERS[0]).toBe("topic_id");
    expect(SORTED_TRENDS_HEADERS[8]).toBe("trend_score");
    expect(SORTED_TRENDS_HEADERS[23]).toBe("is_latest");
    expect(SORTED_TRENDS_HEADERS[24]).toBe("hidden");
    expect([...SORTED_TRENDS_HEADERS]).toContain("content_angles");
  });

  it("daily_digest has the 11 spec columns in order", () => {
    expect([...DAILY_DIGEST_HEADERS]).toEqual([
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
    ]);
  });

  it("runs_log headers match the spec field list", () => {
    expect([...RUNS_LOG_HEADERS]).toEqual([
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
    ]);
  });

  it("TAB_HEADERS covers every required tab", () => {
    for (const tab of REQUIRED_TABS) {
      expect(TAB_HEADERS[tab]).toBeDefined();
      expect(TAB_HEADERS[tab]!.length).toBeGreaterThan(0);
    }
  });

  it("append batches are capped at 500 rows", () => {
    expect(MAX_APPEND_BATCH).toBe(500);
  });
});

describe("record schemas", () => {
  it("accepts a minimal valid raw record", () => {
    const record = RawTrendRecord.parse({
      id: "01JAAA",
      run_id: "01JAAB",
      collected_at: "2026-09-30T06:02:11Z",
      source: "hackernews",
      source_item_id: "123",
      url: "https://example.com/a",
      title: "Example",
      snippet: "",
      author: null,
      published_at: null,
      engagement_score: 42,
      engagement_extra: { comments: 7 },
      engagement_norm: 0.5,
      language: "en",
      region: null,
      content_hash: "abc",
      merged_sources: [],
      extraction_model: null,
      source_label: null,
    });
    expect(record.source).toBe("hackernews");
  });

  it("rejects an unknown category on sorted records", () => {
    expect(() =>
      SortedTrendRecord.parse({
        topic_id: "t1",
        run_id: "r1",
        run_date: "2026-09-30",
        rank: 1,
        title: "T",
        summary: "S",
        category: "NotACategory",
        tags: [],
        trend_score: 90,
        score_engagement: 0.9,
        score_diversity: 0.5,
        score_relevance: 0.8,
        score_novelty: 0.7,
        momentum: "rising",
        sentiment: "neutral",
        why_trending: "W",
        content_angles: ["a"],
        evidence_item_ids: ["x"],
        source_count: 1,
        top_urls: [],
        jev_model: "jev",
        prompt_version: "v1",
        sorted_at: "2026-09-30T07:00:00Z",
        is_latest: true,
        hidden: false,
      }),
    ).toThrow();
  });

  it("digest and run-log records validate their JSON-ish fields", () => {
    const digest = DigestRecord.parse({
      run_date: "2026-09-30",
      run_id: "r1",
      digest: "Three sentences.",
      top_topic_id: "t1",
      topics_count: 5,
      items_count: 100,
      sources_ok: 7,
      sources_total: 8,
      top_categories: [{ category: "AI", count: 3 }],
      created_at: "2026-09-30T07:00:00Z",
      is_latest: true,
    });
    expect(digest.topics_count).toBe(5);

    const run = RunLogRecord.parse({
      run_id: "r1",
      started_at: "2026-09-30T06:00:00Z",
      finished_at: null,
      trigger: "cron",
      status: "success",
      stages: [],
      source_stats: {},
      items_collected: 10,
      items_new: 9,
      topics_count: 2,
      llm_calls: 1,
      tokens_in: 100,
      tokens_out: 50,
      errors: [],
      app_version: "0.1.0",
    });
    expect(run.trigger).toBe("cron");
  });
});
