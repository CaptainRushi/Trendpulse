/**
 * Step-5 normalize + dedupe contract (docs/12 Prompt 5). Titles start with the
 * test ID per CLAUDE.md rule 9. Additive — descriptive Phase-4 suites stay.
 */
import { describe, expect, it } from "vitest";
import type { RawItemDraft } from "../../src/collectors/types.js";
import { applyEngagementNorm, normalizeDrafts } from "../../src/pipeline/normalize.js";
import type { NormalizedItem } from "../../src/pipeline/normalize.js";
import { filterSeenItems, mergeNearDuplicates, recordSeenItems } from "../../src/pipeline/dedupe.js";
import { persistRawItems, prepareRunItems } from "../../src/pipeline/persist.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { canonicalizeUrl } from "../../src/utils/url.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { insertRun, openTestDb } from "../pipeline/helpers.js";

function draft(overrides: Partial<RawItemDraft> & { title: string; url: string }): RawItemDraft {
  return {
    source: "hackernews",
    source_item_id: null,
    snippet: "",
    author: null,
    published_at: null,
    engagement_score: null,
    engagement: {},
    language: null,
    region: null,
    extraction_model: null,
    ...overrides,
  };
}

function normalized(title: string, source: RawItemDraft["source"] = "hackernews", score: number | null = null): NormalizedItem {
  const [item] = normalizeDrafts([draft({ title, url: `https://example.com/${encodeURIComponent(title.slice(0, 20))}`, engagement_score: score, source })]).items;
  if (!item) throw new Error("draft did not normalize");
  return item;
}

describe("STEP 5 normalize and dedupe", () => {
  it("NRM-01 canonicalizes hosts, drops tracking params and fragments, sorts params", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM/Story?utm_source=x&b=2&a=1#comments")).toBe(
      "https://example.com/Story?a=1&b=2",
    );
    expect(canonicalizeUrl("https://example.com/p?fbclid=abc&gclid=123&ref_src=hn&x=9")).toBe(
      "https://example.com/p?x=9",
    );
    expect(canonicalizeUrl("https://example.com/a?utm_medium=email")).toBe("https://example.com/a");
    expect(canonicalizeUrl("not a url")).toBeNull();
  });

  it("NRM-02 content hashes are stable across param order and utm variants", () => {
    const a = normalizeDrafts([draft({ title: "T", url: "https://example.com/s?b=2&a=1" })]).items[0]!;
    const b = normalizeDrafts([draft({ title: "T", url: "https://EXAMPLE.com/s?a=1&b=2&utm_campaign=z#frag" })]).items[0]!;
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.url).toBe(b.url);
  });

  it("NRM-03 near-duplicate titles merge into the highest-engagement keeper", () => {
    const items = [
      normalized("New AI model released by lab today", "hackernews", 10),
      normalized("New AI model released by lab today!", "reddit", 99),
      normalized("Completely unrelated gardening post", "rss", 5),
    ];
    const merged = mergeNearDuplicates(items);
    expect(merged.kept).toBe(2);
    expect(merged.merged).toBe(1);
    const keeper = merged.items.find((i) => i.source === "reddit");
    expect(keeper?.engagement_score).toBe(99);
    expect(keeper?.merged_sources).toContain("hackernews");
  });

  it("NRM-04 cross-day seen hashes drop within the window only", () => {
    const db = openTestDb();
    try {
      const items = [normalized("Fresh story one"), normalized("Fresh story two")];
      recordSeenItems(
        db,
        [{ content_hash: items[0]!.content_hash, source: "hackernews" }],
        "2026-09-29",
      );
      const inWindow = filterSeenItems(db, items, { runDate: "2026-09-30", dedupeDays: 3 });
      expect(inWindow.fresh.map((i) => i.title)).toEqual(["Fresh story two"]);
      expect(inWindow.seenCount).toBe(1);
      const outOfWindow = filterSeenItems(db, items, { runDate: "2026-10-10", dedupeDays: 3 });
      expect(outOfWindow.fresh).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("NRM-05 same-day rerun adds 0 rows", async () => {
    const db = openTestDb();
    try {
      const sheets = new FakeSheetsClient();
      const repo = new SheetsRepo(sheets, {
        spreadsheetId: "s",
        cacheTtlS: 60,
        queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
      });
      const drafts = [
        draft({ title: "Rerun story alpha", url: "https://example.com/alpha", engagement_score: 5 }),
        draft({ title: "Rerun story beta", url: "https://example.com/beta", engagement_score: 7 }),
      ];
      insertRun(db, "run-day-1", "2026-09-30");
      prepareRunItems(db, { runId: "run-day-1", runDate: "2026-09-30", drafts, dedupeDays: 3 });
      await persistRawItems(db, repo, "run-day-1", "2026-09-30");
      const before = sheets.rowCount("raw_trends");

      insertRun(db, "run-day-2", "2026-09-30");
      const second = prepareRunItems(db, { runId: "run-day-2", runDate: "2026-09-30", drafts, dedupeDays: 3 });
      expect(second.items).toHaveLength(0);
      await persistRawItems(db, repo, "run-day-2", "2026-09-30");
      expect(sheets.rowCount("raw_trends")).toBe(before);
    } finally {
      db.close();
    }
  });

  it("NRM-06 engagement percentile ranks 0..1 within a source", () => {
    const items = [10, 20, 30, 40].map((score) => normalized(`Percentile ${String(score)}`, "github", score));
    const norms = applyEngagementNorm(items).map((i) => i.engagement_norm);
    expect(norms).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it("NRM-07 scoreless sources fall back to position 1-pos/N", () => {
    const items = ["First feed item", "Second feed item", "Third feed item"].map((title) =>
      normalized(title, "rss", null),
    );
    const norms = applyEngagementNorm(items).map((i) => i.engagement_norm);
    expect(norms[0]).toBe(1);
    expect(norms[1]).toBeCloseTo(2 / 3, 10);
    expect(norms[2]).toBeCloseTo(1 / 3, 10);
  });

  it("NRM-08 html, entities and overlong text are cleaned and capped", () => {
    const [item] = normalizeDrafts([
      draft({
        title: "<p>Fish &amp; chips <b>today</b></p>",
        url: "https://example.com/html",
        snippet: `x${"y".repeat(600)}`,
      }),
    ]).items;
    expect(item?.title).toBe("Fish & chips today");
    expect(item?.snippet.length).toBeLessThanOrEqual(500);
    const [long] = normalizeDrafts([draft({ title: `t${"o".repeat(400)}`, url: "https://example.com/long" })]).items;
    expect(long?.title.length).toBeLessThanOrEqual(300);
    const dropped = normalizeDrafts([draft({ title: "   ", url: "https://example.com/empty" })]);
    expect(dropped.items).toHaveLength(0);
    expect(dropped.stats.droppedEmptyTitle).toBe(1);
  });

  it("NRM-10 non-English titles detect language, unknown stays null", () => {
    const [german] = normalizeDrafts([
      draft({ title: "Der schnelle braune Fuchs springt über den faulen Hund", url: "https://example.com/de" }),
    ]).items;
    expect(german?.language).toBe("de");
    const [japanese] = normalizeDrafts([
      draft({ title: "新しいモデルが登場しました", url: "https://example.com/ja" }),
    ]).items;
    expect(japanese?.language).toBe("ja");
    const [unknown] = normalizeDrafts([draft({ title: "xqzt blorpt fnord", url: "https://example.com/zz" })]).items;
    expect(unknown?.language).toBeNull();
  });

  it("W-05 collected minus merged minus seen equals persisted", async () => {
    const db = openTestDb();
    try {
      const sheets = new FakeSheetsClient();
      const repo = new SheetsRepo(sheets, {
        spreadsheetId: "s",
        cacheTtlS: 60,
        queue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
      });
      const drafts = [
        draft({ title: "Counted story one", url: "https://example.com/c1", engagement_score: 1 }),
        draft({ title: "Counted story one!", url: "https://example.com/c1b", engagement_score: 2 }),
        draft({ title: "Counted story two", url: "https://example.com/c2", engagement_score: 3 }),
      ];
      insertRun(db, "run-w5", "2026-09-30");
      const prepared = prepareRunItems(db, { runId: "run-w5", runDate: "2026-09-30", drafts, dedupeDays: 3 });
      expect(prepared.stats.input - prepared.stats.merged - prepared.stats.seenDropped).toBe(prepared.stats.output);
      const persisted = await persistRawItems(db, repo, "run-w5", "2026-09-30");
      expect(persisted.appended).toBe(prepared.stats.output);
      expect(sheets.rowCount("raw_trends")).toBe(prepared.stats.output + 1);
    } finally {
      db.close();
    }
  });
});
