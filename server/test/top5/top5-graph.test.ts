/** Graph restoration: per-category live samples (TOP5-29). */
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";
import { openTestDb } from "../pipeline/helpers.js";
import { insertRun } from "../pipeline/helpers.js";
import { writeLatestSet } from "../../src/pulse/index.js";

const DAY = "2026-09-30";

function seedIndex(db: ReturnType<typeof openTestDb>): void {
  writeLatestSet(db, "run-1", DAY, [
    { topic_id: "ai-1", rank: 1, title: "AI one", trend_score: 90, source_count: 2, hidden: false, evidence_item_ids: ["a1"], category: "AI" },
    { topic_id: "ai-2", rank: 2, title: "AI two", trend_score: 80, source_count: 1, hidden: false, evidence_item_ids: ["a2"], category: "AI" },
    { topic_id: "fin-1", rank: 1, title: "Fin one", trend_score: 70, source_count: 1, hidden: false, evidence_item_ids: ["f1"], category: "Finance" },
  ], 5, `${DAY}T06:00:00.000Z`);
  db.prepare(
    "INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) VALUES (?, ?, 100, 10, 1, 0, '[]')",
  ).run("ai-1", `${DAY}T06:00:00.000Z`);
}

describe("TOP5-29 live samples accept a category", () => {
  it("filters to the category set; unknown slug 400s", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    try {
      seedIndex(t.db);
      const app = await buildApp(t.ctx);
      try {
        const ai = await app.inject({ method: "GET", url: `/api/live/samples?date=${DAY}&category=ai&top=1` });
        expect(ai.statusCode).toBe(200);
        const body = ai.json<{ series: { topic_id: string }[]; category?: string }>();
        expect(body.series.map((s) => s.topic_id)).toEqual(["ai-1"]);
        const bogus = await app.inject({ method: "GET", url: `/api/live/samples?date=${DAY}&category=bogus` });
        expect(bogus.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("each category rank-1 is baselined for the sampler", () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-1", DAY);
      const insert = db.prepare(
        "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted) VALUES (?, 'run-1', ?, 'hackernews', ?, ?, 1)",
      );
      insert.run("a1", DAY, "h1", JSON.stringify({ url: "https://a.example.com/1", engagement_score: 10, source_item_id: "1" }));
      insert.run("f1", DAY, "h2", JSON.stringify({ url: "https://f.example.com/1", engagement_score: 5, source_item_id: "2" }));
      const out = writeLatestSet(db, "run-1", DAY, [
        { topic_id: "ai-1", rank: 1, title: "AI one", trend_score: 90, source_count: 2, hidden: false, evidence_item_ids: ["a1"], category: "AI" },
        { topic_id: "fin-1", rank: 1, title: "Fin one", trend_score: 70, source_count: 1, hidden: false, evidence_item_ids: ["f1"], category: "Finance" },
      ], 1, `${DAY}T06:00:00.000Z`);
      // topN=1 but both category #1s are baselined, not just the first row.
      expect(out.baselined).toBe(2);
    } finally {
      db.close();
    }
  });
});
