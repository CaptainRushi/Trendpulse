/** Doc 19 Q1: settings, per-category sets, header upgrade, my-categories APIs. */
import { describe, expect, it } from "vitest";
import { validateMyCategories } from "../../src/categories/registry.js";
import { buildApp } from "../../src/app.js";
import { testContext, makeSortedTopic } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";
import { openTestDb } from "../pipeline/helpers.js";
import { SORTED_TRENDS_HEADERS } from "../../src/sheets/schema.js";
import { sortedRecordToRow } from "../../src/sheets/mappers.js";

const DAY = "2026-09-30";

function sortedRow(overrides: Record<string, unknown>): string[] {
  return sortedRecordToRow({ ...makeSortedTopic({ run_date: DAY }), ...overrides });
}

describe("TOP5-01 my_categories validation", () => {
  it("accepts empty (onboarding), keeps order, rejects duplicates/unknown/7", () => {
    expect(validateMyCategories([])).toEqual([]);
    expect(validateMyCategories(["finance", "ai"])).toEqual(["finance", "ai"]);
    expect(validateMyCategories([" AI ", "Tech"])).toEqual(["ai", "tech"]);
    expect(() => validateMyCategories(["ai", "ai"])).toThrow(/duplicate/);
    expect(() => validateMyCategories(["bogus"])).toThrow(/unknown categories/);
    expect(() => validateMyCategories(["tech", "ai", "business", "finance", "science", "health", "politics"])).toThrow(
      /at most 6/,
    );
  });

  it("PUT enforces the effective MAX_CATEGORIES, not just the default", async () => {
    const t = testContext();
    const app = await buildApp(t.ctx);
    try {
      const setMax = await app.inject({ method: "PUT", url: "/api/settings", payload: { max_categories: 2 } });
      expect(setMax.statusCode).toBe(200);
      const tooMany = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { my_categories: ["ai", "finance", "science"] },
      });
      expect(tooMany.statusCode).toBe(400);
      const ok = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { my_categories: ["finance", "ai"] },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("TOP5-02 is_latest unique per (date, category)", () => {
  function insert(db: ReturnType<typeof openTestDb>, topicId: string, runId: string, category: string, latest: number): void {
    db.prepare(
      "INSERT INTO topic_index (topic_id, run_id, run_date, rank, title, score, evidence_item_ids_json, is_latest, scope_key, category) " +
        "VALUES (?, ?, ?, 1, ?, 50, '[]', ?, 'all', ?)",
    ).run(topicId, runId, DAY, topicId, latest, category);
  }

  it("migration 010 tags topic_index rows legacy and adds category_runs", () => {
    const db = openTestDb();
    try {
      const cols = db.prepare("PRAGMA table_info(topic_index)").all() as { name: string; dflt_value: string | null }[];
      const category = cols.find((c) => c.name === "category");
      expect(category?.dflt_value).toContain("legacy");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("category_runs");
      // A set holds several latest rows per (date, category); the flip keeps
      // exactly one run latest — assert the flip primitive, not a UNIQUE index.
      insert(db, "t-ai-1", "run-1", "AI", 1);
      insert(db, "t-ai-2", "run-1", "AI", 1);
      db.prepare("UPDATE topic_index SET is_latest = 0 WHERE run_date = ? AND category = ? AND run_id <> ?").run(
        DAY, "AI", "run-2",
      );
      insert(db, "t-ai-3", "run-2", "AI", 1);
      const latest = db.prepare("SELECT topic_id FROM topic_index WHERE run_date = ? AND category = ? AND is_latest = 1").all(DAY, "AI") as {
        topic_id: string;
      }[];
      expect(latest.map((r) => r.topic_id).sort()).toEqual(["t-ai-3"]);
    } finally {
      db.close();
    }
  });

  it("refreshing one category leaves the other category latest", async () => {
    const t = testContext();
    try {
      await t.sheets.addTab("sorted_trends");
      await t.sheets.addTab("daily_digest");
      await t.sheets.writeFirstRow("test-sheet", "sorted_trends", [...SORTED_TRENDS_HEADERS]);
      await t.sheets.writeFirstRow("test-sheet", "daily_digest", [
        "run_date", "run_id", "x", "x", "x", "x", "x", "x", "x", "x", "is_latest",
      ]);
      await t.sheets.appendRows("test-sheet", "sorted_trends", [
        sortedRow({ topic_id: "ai-old", run_id: "run-old", category: "AI", is_latest: true }),
        sortedRow({ topic_id: "ai-new", run_id: "run-new", category: "AI", is_latest: true }),
        sortedRow({ topic_id: "fin-old", run_id: "run-old", category: "Finance", is_latest: true }),
      ]);
      const flipped = await t.repo.markLatest(DAY, "run-new", { category: "AI" });
      expect(flipped.flipped).toBe(1);
      const values = await t.sheets.getAllValues("test-sheet", "sorted_trends");
      expect(values[1]?.[23]).toBe("FALSE");
      expect(values[2]?.[23]).toBe("TRUE");
      expect(values[3]?.[23]).toBe("TRUE");
    } finally {
      await t.close();
    }
  });
});

describe("TOP5-03 sheet header upgrade is idempotent and old rows readable", () => {
  it("upgrades once, then reads a pre-scope 25-col row as non-legacy", async () => {
    const t = testContext();
    try {
      await t.sheets.addTab("sorted_trends");
      await t.sheets.writeFirstRow("test-sheet", "sorted_trends", [...SORTED_TRENDS_HEADERS].slice(0, 25));
      await t.sheets.appendRows("test-sheet", "sorted_trends", [
        sortedRecordToRow({ ...makeSortedTopic({ run_date: DAY }), scope: "all" }).slice(0, 25),
      ]);
      const first = await t.repo.init();
      expect(first.upgraded).toContain("sorted_trends");
      expect(await t.sheets.getFirstRow("test-sheet", "sorted_trends")).toEqual([...SORTED_TRENDS_HEADERS]);
      const second = await t.repo.init();
      expect(second.upgraded).toEqual([]);
      const read = await t.repo.readSorted({ runDate: DAY, onlyLatest: false });
      expect(read.rows).toHaveLength(1);
      expect(read.rows[0]?.scope).toBe("all");
    } finally {
      await t.close();
    }
  });
});

describe("TOP5-04 my-categories and per-category read APIs", () => {
  async function seedSheets(t: ReturnType<typeof testContext>): Promise<void> {
    await t.sheets.addTab("sorted_trends");
    await t.sheets.writeFirstRow("test-sheet", "sorted_trends", [...SORTED_TRENDS_HEADERS]);
    const rows: string[][] = [];
    for (let i = 1; i <= 6; i += 1) {
      rows.push(sortedRow({ topic_id: `ai-${String(i)}`, run_id: "run-1", rank: i, category: "AI", trend_score: 100 - i }));
    }
    rows.push(sortedRow({ topic_id: "ai-hidden", run_id: "run-1", rank: 7, category: "AI", trend_score: 10, hidden: true }));
    for (let i = 1; i <= 2; i += 1) {
      rows.push(sortedRow({ topic_id: `fin-${String(i)}`, run_id: "run-1", rank: i, category: "Finance", trend_score: 90 - i }));
    }
    // Doc-17 scoped row: legacy, never part of a category set.
    rows.push(sortedRow({ topic_id: "legacy-1", run_id: "run-0", rank: 1, category: "AI", trend_score: 99, scope: "ai+finance" }));
    await t.sheets.appendRows("test-sheet", "sorted_trends", rows);
  }

  it("GET/PUT /api/my-categories round-trips the ordered list", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const empty = await app.inject({ method: "GET", url: "/api/my-categories" });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({
        my_categories: [],
        max_categories: 6,
        top_per_category: 5,
        include_general_sources: false,
      });
      const put = await app.inject({
        method: "PUT",
        url: "/api/my-categories",
        payload: { my_categories: ["finance", "ai"] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ my_categories: ["finance", "ai"] });
      const back = await app.inject({ method: "GET", url: "/api/my-categories" });
      expect(back.json()).toMatchObject({ my_categories: ["finance", "ai"] });
      for (const bad of [["ai", "ai"], ["bogus"], ["tech", "ai", "business", "finance", "science", "health", "politics"]]) {
        const res = await app.inject({ method: "PUT", url: "/api/my-categories", payload: { my_categories: bad } });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
      await t.close();
    }
  });

  it("GET /api/today/categories returns one panel per selected category", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      await seedSheets(t);
      await app.inject({ method: "PUT", url: "/api/my-categories", payload: { my_categories: ["ai", "finance"] } });
      const res = await app.inject({ method: "GET", url: "/api/today/categories" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ categories: Record<string, unknown>[] }>();
      expect(body.categories.map((c) => (c as { category: string }).category)).toEqual(["ai", "finance"]);
      const ai = body.categories[0] as {
        status: string; topics: { id: string; rank: number }[]; note?: string; sources: { name: string; status: string }[]; stats: object;
      };
      expect(ai.status).toBe("ok");
      expect(ai.topics).toHaveLength(5);
      expect(ai.topics.map((x) => x.id)).not.toContain("ai-hidden");
      expect(ai.topics.map((x) => x.id)).not.toContain("legacy-1");
      expect(ai.note ?? "").toContain("hidden by you");
      expect(ai.sources.length).toBeGreaterThan(0);
      const finance = body.categories[1] as { topics: unknown[]; note?: string };
      expect(finance.topics).toHaveLength(2);
      expect(finance.note ?? "").toContain("sources may be thin");
    } finally {
      await app.close();
      await t.close();
    }
  });

  it("GET /api/trends?category= returns at most TOP_PER_CATEGORY, unknown slug 400s", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      await seedSheets(t);
      const ai = await app.inject({ method: "GET", url: `/api/trends?date=${DAY}&category=ai` });
      expect(ai.statusCode).toBe(200);
      const body = ai.json<{ items: { topic_id: string; category: string }[]; total: number }>();
      expect(body.total).toBeLessThanOrEqual(5);
      expect(body.items).toHaveLength(body.total);
      expect(body.items.every((x) => x.category === "AI")).toBe(true);
      const bogus = await app.inject({ method: "GET", url: `/api/trends?date=${DAY}&category=bogus` });
      expect(bogus.statusCode).toBe(400);
    } finally {
      await app.close();
      await t.close();
    }
  });
});
