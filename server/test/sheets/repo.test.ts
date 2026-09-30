import { describe, expect, it } from "vitest";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import {
  RAW_TRENDS_HEADERS,
  SORTED_TRENDS_HEADERS,
  type RawTrendRecord,
  type SortedTrendRecord,
} from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";

const SHEET_ID = "sheet-123";

function rawRecord(id: string, runId = "run-1"): RawTrendRecord {
  return {
    id,
    run_id: runId,
    collected_at: "2026-09-30T06:02:11Z",
    source: "hackernews",
    source_item_id: id,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    snippet: "",
    author: null,
    published_at: null,
    engagement_score: 10,
    engagement_extra: {},
    engagement_norm: 0.5,
    language: "en",
    region: null,
    content_hash: `hash-${id}`,
    merged_sources: [],
    extraction_model: null,
  };
}

function sortedRecord(topicId: string, runId: string, latest: boolean): SortedTrendRecord {
  return {
    topic_id: topicId,
    run_id: runId,
    run_date: "2026-09-30",
    rank: 1,
    title: `Topic ${topicId}`,
    summary: "Summary.",
    category: "Tech",
    tags: [],
    trend_score: 80,
    score_engagement: 0.8,
    score_diversity: 0.5,
    score_relevance: 0.7,
    score_novelty: 0.6,
    momentum: "new",
    sentiment: "neutral",
    why_trending: "Why.",
    content_angles: ["a"],
    evidence_item_ids: ["x"],
    source_count: 1,
    top_urls: [],
    jev_model: "jev",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00Z",
    is_latest: latest,
    hidden: false,
  };
}

function testRepo(client: FakeSheetsClient): SheetsRepo {
  return new SheetsRepo(client, {
    spreadsheetId: SHEET_ID,
    cacheTtlS: 60,
    queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
  });
}

describe("SheetsRepo", () => {
  it("init creates missing tabs with headers and is idempotent", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);

    const first = await repo.init();
    expect(first.created).toHaveLength(4);
    for (const tab of ["raw_trends", "sorted_trends", "daily_digest", "runs_log"]) {
      expect(client.tabs.get(tab)?.[0]).toEqual(
        expect.arrayContaining([tab === "raw_trends" ? "content_hash" : "run_id"]),
      );
    }

    const second = await repo.init();
    expect(second.created).toEqual([]);
    // No duplicate header rows: each tab still has exactly one row (the header).
    for (const tab of ["raw_trends", "sorted_trends", "daily_digest", "runs_log"]) {
      expect(client.rowCount(tab)).toBe(1);
    }
    expect(client.tabs.get("raw_trends")?.[0]).toEqual([...RAW_TRENDS_HEADERS]);
    expect(client.tabs.get("sorted_trends")?.[0]).toEqual([...SORTED_TRENDS_HEADERS]);
  });

  it("appends 1200 rows in 3 ordered batches of ≤500", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();

    const records = Array.from({ length: 1200 }, (_, i) => rawRecord(`id-${String(i)}`));
    const result = await repo.appendRaw(records);
    expect(result).toEqual({ rowsAppended: 1200, batches: 3 });

    const appends = client.callsTo("appendRows");
    expect(appends.map((c) => c.rows)).toEqual([500, 500, 200]);

    const stored = client.tabs.get("raw_trends")!.slice(1);
    expect(stored).toHaveLength(1200);
    expect(stored[0]![0]).toBe("id-0");
    expect(stored[1199]![0]).toBe("id-1199");
  });

  it("retries a 429 and still appends", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    client.failNext({ method: "appendRows", times: 1, status: 429 });

    await repo.appendRaw([rawRecord("id-1")]);
    expect(client.rowCount("raw_trends")).toBe(2); // header + 1 row
    expect(client.callsTo("appendRows")).toHaveLength(2); // failed attempt + retry
  });

  it("auto re-inits when the tab was deleted, then writes", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    client.deleteTab("raw_trends");

    await repo.appendRaw([rawRecord("id-9")]);
    expect(client.tabs.get("raw_trends")?.[0]).toEqual([...RAW_TRENDS_HEADERS]);
    expect(client.rowCount("raw_trends")).toBe(2);
  });

  it("reads back rows and skips bad rows with a warning count", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendRaw([rawRecord("good-1"), rawRecord("good-2")]);
    // A human (or bug) broke the second data row's engagement_norm.
    client.tabs.get("raw_trends")![2]![12] = "not-a-number";

    const { rows, warnings } = await repo.readRaw();
    expect(rows.map((r) => r.id)).toEqual(["good-1"]);
    expect(warnings).toBe(1);
  });

  it("readSorted filters to the latest set of the date", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendSorted([sortedRecord("old-1", "run-old", false)]);
    await repo.appendSorted([sortedRecord("new-1", "run-new", true)]);

    const { rows, warnings } = await repo.readSorted({ runDate: "2026-09-30", onlyLatest: true });
    expect(warnings).toBe(0);
    expect(rows.map((r) => r.topic_id)).toEqual(["new-1"]);
  });

  it("markLatest flips older is_latest flags for the date", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendSorted([sortedRecord("old-1", "run-old", true)]);
    await repo.appendSorted([sortedRecord("new-1", "run-new", true)]);

    const { flipped } = await repo.markLatest("2026-09-30", "run-new");
    expect(flipped).toBe(1);

    const { rows } = await repo.readSorted({ runDate: "2026-09-30", onlyLatest: true });
    expect(rows.map((r) => r.topic_id)).toEqual(["new-1"]);
  });

  it("caches reads within the TTL and refetches after sync()", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendRaw([rawRecord("id-1")]);

    await repo.readRaw();
    await repo.readRaw();
    expect(client.callsTo("getAllValues")).toHaveLength(1);

    await repo.sync();
    await repo.readRaw();
    expect(client.callsTo("getAllValues")).toHaveLength(2);
  });

  it("writes invalidate the read cache", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendRaw([rawRecord("id-1")]);
    const first = await repo.readRaw();
    expect(first.rows).toHaveLength(1);

    await repo.appendRaw([rawRecord("id-2")]);
    const second = await repo.readRaw();
    expect(second.rows).toHaveLength(2);
  });

  it("round-trips run-log rows", async () => {
    const client = new FakeSheetsClient();
    const repo = testRepo(client);
    await repo.init();
    await repo.appendRunLog({
      run_id: "run-1",
      started_at: "2026-09-30T06:00:00Z",
      finished_at: "2026-09-30T06:04:00Z",
      trigger: "manual",
      status: "success",
      stages: ["collect"],
      source_stats: { hackernews: "ok" },
      items_collected: 50,
      items_new: 48,
      topics_count: 5,
      llm_calls: 3,
      tokens_in: 1000,
      tokens_out: 500,
      errors: [],
      app_version: "0.1.0",
    });

    const { rows, warnings } = await repo.readRunLog();
    expect(warnings).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_id).toBe("run-1");
    expect(rows[0]?.status).toBe("success");
  });
});
