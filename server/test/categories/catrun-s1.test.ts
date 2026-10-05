import { describe, expect, it } from "vitest";
import {
  CATEGORY_REGISTRY,
  CATEGORY_SLUGS,
  effectiveSources,
  normalizeScope,
  validateCategorySources,
} from "../../src/categories/registry.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SORTED_TRENDS_HEADERS } from "../../src/sheets/schema.js";
import { sortedRecordToRow } from "../../src/sheets/mappers.js";
import { makeSortedTopic } from "../api/helpers.js";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";

describe("CATRUN-01 registry validation", () => {
  it("every category except other has 1-3 sources; bad params rejected", () => {
    for (const slug of CATEGORY_SLUGS) {
      const entry = CATEGORY_REGISTRY[slug];
      expect(entry, slug).toBeDefined();
      if (slug === "other") {
        expect(entry?.sources).toEqual([]);
      } else {
        expect(entry?.sources.length, slug).toBeGreaterThanOrEqual(1);
        expect(entry?.sources.length, slug).toBeLessThanOrEqual(3);
      }
    }
    expect(() => validateCategorySources({ tech: [{ collector: "rss", params: {} }] })).not.toThrow();
    expect(() => validateCategorySources({ nope: [] })).toThrow(/unknown category/);
    expect(() => validateCategorySources({ tech: "x" })).toThrow();
    expect(() =>
      validateCategorySources({ tech: [1, 2, 3, 4].map(() => ({ collector: "rss", params: {} })) }),
    ).toThrow(/1-3/);
    expect(() => validateCategorySources({ tech: [{ collector: "rss", params: { feeds: ["not-a-url"] } }] })).toThrow();
    // Overrides replace defaults wholesale.
    expect(effectiveSources("tech", { tech: [] })).toEqual([]);
    expect(effectiveSources("tech").length).toBeGreaterThan(0);
  });
});

describe("CATRUN-02 scope_key normalization", () => {
  it("all, sorted join, max 5, unknown rejected", () => {
    expect(normalizeScope([])).toBe("all");
    expect(normalizeScope(["finance", "ai"])).toBe("ai+finance");
    expect(normalizeScope(["AI", "ai", " finance "])).toBe("ai+finance");
    expect(normalizeScope(["all"])).toBe("all");
    expect(() => normalizeScope(["a", "b", "c", "d", "e", "f"])).toThrow(/at most 5/);
    expect(() => normalizeScope(["bogus"])).toThrow(/unknown categories/);
  });
});

function sortedRow(topicId: string, runId: string, scope: string, latest: boolean): string[] {
  const record = { ...makeSortedTopic({ topic_id: topicId, run_id: runId, is_latest: latest, hidden: false }), scope };
  return sortedRecordToRow(record);
}

describe("CATRUN-09 is_latest per (date, scope)", () => {
  it("markLatest flips only the same scope", async () => {
    const fake = new FakeSheetsClient();
    await fake.addTab("sorted_trends");
    await fake.addTab("daily_digest");
    await fake.writeFirstRow("s", "sorted_trends", [...SORTED_TRENDS_HEADERS]);
    await fake.writeFirstRow("s", "daily_digest", ["run_date", "run_id", "x", "x", "x", "x", "x", "x", "x", "x", "is_latest"]);
    await fake.appendRows("s", "sorted_trends", [
      sortedRow("a1", "run-old", "ai", true),
      sortedRow("a2", "run-new", "ai", true),
      sortedRow("b1", "run-old", "all", true),
    ]);
    const repo = new SheetsRepo(fake, {
      spreadsheetId: "s",
      queue: new SheetsWriteQueue({ sleep: () => Promise.resolve(), now: () => 0 }),
    });
    const flipped = await repo.markLatest("2026-09-30", "run-new", "ai");
    expect(flipped.flipped).toBe(1);
    const values = await fake.getAllValues("s", "sorted_trends");
    expect(values[1]?.[23]).toBe("FALSE");
    expect(values[3]?.[23]).toBe("TRUE");
  });
});

describe("CATRUN-10 sheet header upgrade is idempotent, old rows read as all", () => {
  it("appends only the missing trailing cells", async () => {
    const fake = new FakeSheetsClient();
    await fake.addTab("sorted_trends");
    // Old 25-col sheet: header without scope + one data row.
    await fake.writeFirstRow("s", "sorted_trends", [...SORTED_TRENDS_HEADERS].slice(0, 25));
    await fake.appendRows("s", "sorted_trends", [sortedRow("a1", "run-1", "all", true).slice(0, 25)]);
    const repo = new SheetsRepo(fake, {
      spreadsheetId: "s",
      queue: new SheetsWriteQueue({ sleep: () => Promise.resolve(), now: () => 0 }),
    });
    const first = await repo.init();
    expect(first.upgraded).toContain("sorted_trends");
    expect(await fake.getFirstRow("s", "sorted_trends")).toEqual([...SORTED_TRENDS_HEADERS]);
    const second = await repo.init();
    expect(second.upgraded).toEqual([]);
    const read = await repo.readSorted({ runDate: "2026-09-30", onlyLatest: false });
    expect(read.rows[0]?.scope).toBe("all");
  });
});

describe("CATRUN-11 trends API by scope", () => {
  it("filters by scope; unknown scope is empty with a hint", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      await t.sheets.addTab("sorted_trends");
      await t.sheets.writeFirstRow("test-sheet", "sorted_trends", [...SORTED_TRENDS_HEADERS, "scope"]);
      await t.sheets.appendRows("test-sheet", "sorted_trends", [
        sortedRow("a1", "run-1", "ai", true),
        sortedRow("b1", "run-1", "all", true),
      ]);
      const ai = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30&scope=ai" });
      expect(ai.statusCode).toBe(200);
      expect(ai.json<{ scope: string; total: number }>()).toMatchObject({ scope: "ai", total: 1 });
      const all = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30" });
      expect(all.json<{ total: number }>().total).toBe(1);
      const bogus = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30&scope=bogus" });
      expect(bogus.statusCode).toBe(200);
      const bogusBody = bogus.json<{ items: unknown[]; hint: string }>();
      expect(bogusBody.items).toEqual([]);
      expect(bogusBody.hint).toContain("unknown scope");
    } finally {
      await app.close();
      await t.close();
    }
  });
});
