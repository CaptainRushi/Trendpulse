import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { RawTrendRecord } from "../../src/sheets/schema.js";
import { insertRun } from "../pipeline/helpers.js";
import { makeRawItem } from "../sorting/helpers.js";
import { makeSortedTopic, testContext } from "./helpers.js";
import type { TestApi } from "./helpers.js";

async function seed(t: TestApi): Promise<void> {
  await t.repo.init();
  await t.repo.appendRaw([
    RawTrendRecord.parse({ ...makeRawItem({}), id: "r1", collected_at: "2026-09-30T06:00:00.000Z", source: "rss", title: "Alpha rss" }),
    RawTrendRecord.parse({ ...makeRawItem({}), id: "r2", collected_at: "2026-09-29T06:00:00.000Z", source: "github", title: "Beta gh" }),
  ]);
  insertRun(t.db, "run-1", "2026-09-30");
  t.db
    .prepare(
      "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status) VALUES (?, 'run-1', '2026-09-30', 'rss', 'h1', '{}', 1, 'sorted')",
    )
    .run("r1");
  t.db
    .prepare(
      "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status) VALUES (?, 'run-1', '2026-09-29', 'github', 'h2', '{}', 1, 'discarded')",
    )
    .run("r2");
}

describe("GET /api/raw", () => {
  it("filters by date/source/q/status with pagination", async () => {
    const t = testContext();
    try {
      await seed(t);
      const app = await buildApp(t.ctx);
      try {
        const all = await app.inject({ method: "GET", url: "/api/raw" });
        expect(all.json<{ total: number }>().total).toBe(2);

        const dated = await app.inject({ method: "GET", url: "/api/raw?date=2026-09-30" });
        expect(dated.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r1"]);

        const sourced = await app.inject({ method: "GET", url: "/api/raw?source=github" });
        expect(sourced.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r2"]);

        const queried = await app.inject({ method: "GET", url: "/api/raw?q=ALPHA" });
        expect(queried.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r1"]);

        const stated = await app.inject({ method: "GET", url: "/api/raw?status=discarded" });
        expect(stated.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r2"]);

        const paged = await app.inject({ method: "GET", url: "/api/raw?limit=1&offset=1" });
        const pagedBody = paged.json<{ total: number; items: { id: string }[]; cache: { age_s: number } }>();
        expect(pagedBody.total).toBe(2);
        expect(pagedBody.items).toHaveLength(1);
        expect(typeof pagedBody.cache.age_s).toBe("number");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("rejects bad filters with VALIDATION", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        for (const url of ["/api/raw?status=bogus", "/api/raw?limit=0", "/api/raw?date=x"]) {
          const res = await app.inject({ method: "GET", url });
          expect(res.statusCode).toBe(400);
          expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
        }
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});

describe("exports", () => {
  it("csv quotes, markdown structures, both attach filenames", async () => {
    const t = testContext();
    try {
      await t.repo.init();
      await t.repo.appendSorted([
        makeSortedTopic({
          topic_id: "t1",
          run_date: "2026-09-30",
          rank: 1,
          title: 'Comma, "quoted" title',
          summary: "Line one.",
          evidence_item_ids: ["a1"],
          top_urls: ["https://a.example.com/1"],
        }),
      ]);
      const app = await buildApp(t.ctx);
      try {
        const csv = await app.inject({ method: "GET", url: "/api/export/topics.csv?date=2026-09-30" });
        expect(csv.statusCode).toBe(200);
        expect(csv.headers["content-type"]).toContain("text/csv");
        expect(csv.headers["content-disposition"]).toContain("topics-2026-09-30.csv");
        expect(csv.body).toContain('"Comma, ""quoted"" title"');
        expect(csv.body).toContain("a1");

        const md = await app.inject({ method: "GET", url: "/api/export/topics.md?date=2026-09-30" });
        expect(md.statusCode).toBe(200);
        expect(md.headers["content-type"]).toContain("text/markdown");
        expect(md.body).toContain("# Trends for 2026-09-30");
        expect(md.body).toContain("## 1. Comma,");
        expect(md.body).toContain("https://a.example.com/1");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
