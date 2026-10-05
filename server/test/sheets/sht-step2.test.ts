/**
 * Step-2 Sheets contract (docs/12 Prompt 2). Titles start with the test ID
 * per CLAUDE.md rule 9. Additive to the phase suites — IDs pin the Day-1
 * contract without renaming history.
 */
import { describe, expect, it } from "vitest";
import { mapError } from "../../src/api/errors.js";
import { SheetsCache } from "../../src/sheets/cache.js";
import { SheetsApiError } from "../../src/sheets/client.js";
import {
  rawRecordToRow,
  rowToRawRecord,
  rowToSortedRecord,
  sortedRecordToRow,
} from "../../src/sheets/mappers.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import {
  RAW_TRENDS_HEADERS,
  REQUIRED_TABS,
  SORTED_TRENDS_HEADERS,
  TAB_HEADERS,
  type RawTrendRecord,
  type SortedTrendRecord,
} from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";

function raw(id: string, overrides: Partial<RawTrendRecord> = {}): RawTrendRecord {
  return {
    id,
    run_id: "run-1",
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
    source_label: null,
    target_category: null,
    ...overrides,
  };
}

function sorted(topicId: string, runId: string, latest: boolean): SortedTrendRecord {
  return {
    topic_id: topicId,
    run_id: runId,
    run_date: "2026-09-30",
    rank: 1,
    title: `Topic ${topicId}`,
    summary: "Summary.",
    category: "Tech",
    tags: ["t"],
    trend_score: 80,
    score_engagement: 0.8,
    score_diversity: 0.5,
    score_relevance: 0.7,
    score_novelty: 0.6,
    momentum: "new",
    sentiment: "neutral",
    why_trending: "Why.",
    content_angles: ["a1", "a2", "a3"],
    evidence_item_ids: ["x"],
    source_count: 1,
    top_urls: ["https://example.com/x"],
    jev_model: "jev",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00Z",
    is_latest: latest,
    hidden: false,
    scope: "all",
  };
}

function repo(client: FakeSheetsClient, cacheTtlS = 60): SheetsRepo {
  return new SheetsRepo(client, {
    spreadsheetId: "sheet-123",
    cacheTtlS,
    queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
  });
}

describe("STEP 2 sheets layer", () => {
  it("SHT-01 init creates tabs and headers from the registry", async () => {
    const client = new FakeSheetsClient();
    const { created } = await repo(client).init();
    expect([...created].sort()).toEqual([...REQUIRED_TABS].sort());
    for (const tab of REQUIRED_TABS) {
      expect(client.tabs.get(tab)?.[0]).toEqual([...TAB_HEADERS[tab]!]);
    }
    expect([...RAW_TRENDS_HEADERS].at(-1)).toBe("target_category");
    expect(RAW_TRENDS_HEADERS).toHaveLength(20);
    expect(SORTED_TRENDS_HEADERS).toHaveLength(26);
  });

  it("SHT-02 init twice is a no-op", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    const second = await r.init();
    expect(second.created).toEqual([]);
    for (const tab of REQUIRED_TABS) expect(client.rowCount(tab)).toBe(1);
  });

  it("SHT-03 1200 rows go in 3 ordered batches of at most 500", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    const result = await r.appendRaw(Array.from({ length: 1200 }, (_, i) => raw(`id-${String(i)}`)));
    expect(result).toEqual({ rowsAppended: 1200, batches: 3 });
    expect(client.callsTo("appendRows").map((c) => c.rows)).toEqual([500, 500, 200]);
    const stored = client.tabs.get("raw_trends")!.slice(1);
    expect(stored[0]![0]).toBe("id-0");
    expect(stored[1199]![0]).toBe("id-1199");
  });

  it("SHT-04 429 retries without duplicating rows", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    client.failNext({ method: "appendRows", times: 1, status: 429 });
    await r.appendRaw([raw("id-1")]);
    expect(client.rowCount("raw_trends")).toBe(2);
    expect(client.callsTo("appendRows")).toHaveLength(2);
  });

  it("SHT-05 403 maps to SHEETS_FORBIDDEN and never retries", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    client.failNext({ method: "appendRows", times: 5, status: 403, errorCode: "FORBIDDEN" });
    const error = await r.appendRaw([raw("id-1")]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SheetsApiError);
    expect(mapError(error).body.error.code).toBe("SHEETS_FORBIDDEN");
    expect(mapError(error).body.error.hint).toMatch(/service-account/i);
    expect(client.callsTo("appendRows")).toHaveLength(1);
    expect(client.rowCount("raw_trends")).toBe(1);
  });

  it("SHT-06 deleted tab auto re-inits once, then writes", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    client.deleteTab("raw_trends");
    await r.appendRaw([raw("id-9")]);
    expect(client.tabs.get("raw_trends")?.[0]).toEqual([...RAW_TRENDS_HEADERS]);
    expect(client.rowCount("raw_trends")).toBe(2);
  });

  it("SHT-07 bad rows are skipped and counted as warnings", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendRaw([raw("good-1"), raw("good-2")]);
    client.tabs.get("raw_trends")![2]![12] = "not-a-number";
    const { rows, warnings } = await r.readRaw();
    expect(rows.map((x) => x.id)).toEqual(["good-1"]);
    expect(warnings).toBe(1);
  });

  it("SHT-08 markLatest flips only older rows of that date", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendSorted([sorted("old-1", "run-old", true)]);
    await r.appendSorted([sorted("other-date", "run-other", true)]);
    // Move other-date row to a different run_date.
    client.tabs.get("sorted_trends")![2]![2] = "2026-09-29";
    await r.appendSorted([sorted("new-1", "run-new", true)]);
    const { flipped } = await r.markLatest("2026-09-30", "run-new");
    expect(flipped).toBe(1);
    const { rows } = await r.readSorted({ runDate: "2026-09-30", onlyLatest: true });
    expect(rows.map((x) => x.topic_id)).toEqual(["new-1"]);
    const all = await r.readSorted({ onlyLatest: false });
    expect(all.rows.map((x) => x.topic_id).sort()).toEqual(["new-1", "old-1", "other-date"]);
  });

  it("SHT-09 hidden rows are excluded from reads", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendSorted([sorted("shown-1", "run-new", true), { ...sorted("hid-1", "run-new", true), hidden: true }]);
    const { rows } = await r.readSorted({ runDate: "2026-09-30", onlyLatest: true });
    expect(rows.map((x) => x.topic_id)).toEqual(["shown-1"]);
  });

  it("SHT-10 cache TTL and invalidate", async () => {
    let now = 0;
    const cache = new SheetsCache(60, () => now);
    cache.set("k", [1]);
    now = 59_000;
    expect(cache.get("k")).toBeDefined();
    now = 61_000;
    expect(cache.get("k")).toBeUndefined();

    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendRaw([raw("id-1")]);
    await r.readRaw();
    await r.readRaw();
    expect(client.callsTo("getAllValues")).toHaveLength(1);
    await r.sync();
    await r.readRaw();
    expect(client.callsTo("getAllValues")).toHaveLength(2);
  });

  it("SHT-14 long fields are truncated to 2000 chars", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendRaw([raw("long-1", { title: "t".repeat(2500), snippet: "s".repeat(3000) })]);
    const cells = client.tabs.get("raw_trends")![1]!;
    expect(cells[6]!.length).toBe(2000);
    expect(cells[7]!.length).toBe(2000);
    const { rows, warnings } = await r.readRaw();
    expect(warnings).toBe(0);
    expect(rows[0]!.title.length).toBe(2000);
  });

  it("SHT-16 raw tab is never updated in place", async () => {
    const client = new FakeSheetsClient();
    const r = repo(client);
    await r.init();
    await r.appendRaw([raw("a-1")]);
    await r.appendRaw([raw("a-2")]);
    expect(client.rowCount("raw_trends")).toBe(3);
    expect(client.callsTo("batchUpdate")).toHaveLength(0);
  });

  it("W-01 RawItem round-trips through a raw_trends row", () => {
    const record = raw("w1", { source_label: "r/technology", merged_sources: ["reddit"] });
    const row = rawRecordToRow(record);
    expect(row).toHaveLength(20);
    expect(row[18]).toBe("r/technology");
    expect(rowToRawRecord(row)).toEqual(record);
    // Legacy 18-col rows (pre-label) still parse with a null label.
    expect(rowToRawRecord(row.slice(0, 18)).source_label).toBeNull();
  });

  it("W-02 SortedTopic round-trips through a sorted_trends row", () => {
    const record = { ...sorted("w1", "run-w", true), hidden: true };
    const row = sortedRecordToRow(record);
    expect(row).toHaveLength(26);
    const back = rowToSortedRecord(row);
    expect(back).toEqual(record);
    expect(back.is_latest).toBe(true);
    expect(back.hidden).toBe(true);
  });
});

