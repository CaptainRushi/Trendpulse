import { describe, expect, it } from "vitest";
import {
  digestRecordToRow,
  rawRecordToRow,
  rowToDigestRecord,
  rowToRawRecord,
  rowToRunLogRecord,
  rowToSortedRecord,
  runLogRecordToRow,
  sortedRecordToRow,
  RowParseError,
} from "../../src/sheets/mappers.js";
import type {
  DigestRecord as Digest,
  RawTrendRecord as Raw,
  RunLogRecord as RunLog,
  SortedTrendRecord as Sorted,
} from "../../src/sheets/schema.js";

const rawSample: Raw = {
  id: "01JAAA",
  run_id: "01JAAB",
  collected_at: "2026-09-30T06:02:11Z",
  source: "hackernews",
  source_item_id: "424242",
  url: "https://example.com/story",
  title: "Example story",
  snippet: "A snippet.",
  author: "pg",
  published_at: "2026-09-29T10:00:00Z",
  engagement_score: 210,
  engagement_extra: { comments: 48 },
  engagement_norm: 0.92,
  language: "en",
  region: "US",
  content_hash: "sha1abc",
  merged_sources: ["reddit"],
  extraction_model: null,
  source_label: null,
  target_category: null,
};

const sortedSample: Sorted = {
  topic_id: "01JT1",
  run_id: "01JAAB",
  run_date: "2026-09-30",
  rank: 1,
  title: "Agents everywhere",
  summary: "AI agents dominate HN and Reddit today.",
  category: "AI",
  tags: ["agents", "llm"],
  trend_score: 92,
  score_engagement: 0.9,
  score_diversity: 0.75,
  score_relevance: 0.8,
  score_novelty: 0.7,
  momentum: "rising",
  sentiment: "positive",
  why_trending: "Three launches in one day.",
  content_angles: ["a1", "a2", "a3"],
  evidence_item_ids: ["01JAAA", "01JAAC"],
  source_count: 3,
  top_urls: ["https://example.com/story"],
  jev_model: "jev",
  prompt_version: "v1",
  sorted_at: "2026-09-30T07:00:00Z",
  is_latest: true,
  hidden: false,
  scope: "all",
};

describe("mappers", () => {
  it("round-trips a raw record through a sheet row", () => {
    const row = rawRecordToRow(rawSample);
    expect(row).toHaveLength(20);
    expect(rowToRawRecord(row)).toEqual(rawSample);
  });

  it("round-trips a sorted record through a sheet row", () => {
    const row = sortedRecordToRow(sortedSample);
    expect(row).toHaveLength(26);
    expect(rowToSortedRecord(row)).toEqual(sortedSample);
  });

  it("round-trips digest and run-log records", () => {
    const digest: Digest = {
      run_date: "2026-09-30",
      run_id: "01JAAB",
      digest: "Three sentences here.",
      top_topic_id: "01JT1",
      topics_count: 12,
      items_count: 300,
      sources_ok: 7,
      sources_total: 8,
      top_categories: [{ category: "AI", count: 5 }],
      created_at: "2026-09-30T07:05:00Z",
      is_latest: true,
    };
    const digestRow = digestRecordToRow(digest);
    expect(digestRow).toHaveLength(11);
    expect(rowToDigestRecord(digestRow)).toEqual(digest);

    const run: RunLog = {
      run_id: "01JAAB",
      started_at: "2026-09-30T06:00:00Z",
      finished_at: "2026-09-30T06:04:00Z",
      trigger: "cron",
      status: "success",
      stages: ["collect", "sort"],
      source_stats: { hackernews: "ok" },
      items_collected: 300,
      items_new: 280,
      topics_count: 12,
      llm_calls: 11,
      tokens_in: 9000,
      tokens_out: 4000,
      errors: [],
      app_version: "0.1.0",
      categories: [],
    };
    expect(rowToRunLogRecord(runLogRecordToRow(run))).toEqual(run);
  });

  it("rejects a row with a non-numeric trend_score", () => {
    const row = sortedRecordToRow(sortedSample);
    row[8] = "ninety-two";
    expect(() => rowToSortedRecord(row)).toThrow(RowParseError);
  });

  it("rejects a row with an unknown category", () => {
    const row = sortedRecordToRow(sortedSample);
    row[6] = "Gossip";
    expect(() => rowToSortedRecord(row)).toThrow(RowParseError);
  });

  it("rejects a row with corrupt JSON in a json cell", () => {
    const row = rawRecordToRow(rawSample);
    row[11] = "{not json";
    expect(() => rowToRawRecord(row)).toThrow(RowParseError);
  });

  it("rejects a row with a broken url", () => {
    const row = rawRecordToRow(rawSample);
    row[5] = "not a url";
    expect(() => rowToRawRecord(row)).toThrow(RowParseError);
  });

  it("parses boolean spellings Sheets may return (TRUE/true/1)", () => {
    const row = sortedRecordToRow(sortedSample);
    row[23] = "TRUE";
    row[24] = "0";
    const parsed = rowToSortedRecord(row);
    expect(parsed.is_latest).toBe(true);
    expect(parsed.hidden).toBe(false);
  });

  it("tolerates short rows (trailing blanks) and nullables", () => {
    const row = rawRecordToRow({ ...rawSample, author: null, published_at: null });
    // Cut after engagement_norm: language/region/hash/arrays fall back to
    // null/""/[] while genuinely corrupt cells still throw (see above).
    const short = row.slice(0, 13);
    const parsed = rowToRawRecord(short);
    expect(parsed.author).toBeNull();
    expect(parsed.language).toBeNull();
    expect(parsed.content_hash).toBe("");
    expect(parsed.merged_sources).toEqual([]);
  });
});

