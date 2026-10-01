import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { RawTrendRecord } from "../../src/sheets/schema.js";
import { makeRawItem } from "../sorting/helpers.js";
import { makeSortedTopic, testContext } from "./helpers.js";
import type { TestApi } from "./helpers.js";

async function seed(t: TestApi): Promise<void> {
  await t.repo.init();
  await t.repo.appendSorted([
    makeSortedTopic({
      topic_id: "t1",
      run_id: "run-1",
      run_date: "2026-09-30",
      rank: 1,
      title: "Alpha launch",
      summary: "Alpha launched today.",
      category: "Tech",
      trend_score: 90,
      momentum: "new",
      evidence_item_ids: ["a1", "a2"],
      top_urls: ["https://a.example.com/1"],
    }),
    makeSortedTopic({
      topic_id: "t2",
      run_id: "run-1",
      run_date: "2026-09-30",
      rank: 2,
      title: "Beta markets",
      summary: "Markets rally on Beta news.",
      category: "Finance",
      trend_score: 40,
      momentum: "steady",
      evidence_item_ids: ["b1"],
      top_urls: [],
    }),
    makeSortedTopic({
      topic_id: "t3",
      run_id: "run-0",
      run_date: "2026-09-29",
      rank: 1,
      title: "Old news",
      summary: "Yesterday's story.",
      category: "Tech",
      trend_score: 70,
      momentum: "fading",
      is_latest: false,
      evidence_item_ids: [],
      top_urls: [],
    }),
    makeSortedTopic({
      topic_id: "t4",
      run_id: "run-1",
      run_date: "2026-09-30",
      rank: 3,
      title: "Hidden gem",
      summary: "Hidden by the user.",
      category: "Tech",
      trend_score: 95,
      hidden: true,
      evidence_item_ids: [],
      top_urls: [],
    }),
  ]);
  await t.repo.appendRaw([
    RawTrendRecord.parse({
      ...makeRawItem({}),
      id: "a1",
      run_id: "run-1",
      source: "hackernews",
      title: "Alpha launch",
    }),
    RawTrendRecord.parse({
      ...makeRawItem({}),
      id: "a2",
      run_id: "run-1",
      source: "reddit",
      title: "Alpha launch",
    }),
    RawTrendRecord.parse({
      ...makeRawItem({}),
      id: "b1",
      run_id: "run-1",
      source: "github",
      title: "Beta markets",
    }),
  ]);
}

describe("GET /api/trends", () => {
  it("filters, sorts and paginates latest topics", async () => {
    const t = testContext();
    try {
      await seed(t);
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ date: string; items: { topic_id: string }[]; total: number; cache: { age_s: number } }>();
        expect(body.date).toBe("2026-09-30");
        expect(body.total).toBe(2); // hidden excluded
        expect(body.items.map((i) => i.topic_id)).toEqual(["t1", "t2"]);
        expect(typeof body.cache.age_s).toBe("number");

        const cat = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30&category=Finance" });
        expect(cat.json<{ total: number; items: { topic_id: string }[] }>()).toMatchObject({
          total: 1,
        });

        const scored = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30&min_score=50" });
        expect(scored.json<{ items: { topic_id: string }[] }>().items.map((i) => i.topic_id)).toEqual(["t1"]);

        const found = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30&q=MARKETS" });
        expect(found.json<{ items: { topic_id: string }[] }>().items.map((i) => i.topic_id)).toEqual(["t2"]);

        const bySource = await app.inject({
          method: "GET",
          url: "/api/trends?date=2026-09-30&source=github",
        });
        expect(bySource.json<{ items: { topic_id: string }[] }>().items.map((i) => i.topic_id)).toEqual(["t2"]);

        const titled = await app.inject({
          method: "GET",
          url: "/api/trends?date=2026-09-30&sort=title&limit=1&offset=1",
        });
        const titledBody = titled.json<{ total: number; items: { title: string }[] }>();
        expect(titledBody.total).toBe(2);
        expect(titledBody.items.map((i) => i.title)).toEqual(["Beta markets"]);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("rejects bad query values with VALIDATION", async () => {
    const t = testContext();
    try {
      const app = buildApp(t.ctx);
      try {
        for (const url of [
          "/api/trends?limit=abc",
          "/api/trends?date=30-09-2026",
          "/api/trends?category=Nope",
          "/api/trends?limit=101",
          "/api/trends?sort=hot",
        ]) {
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

describe("GET /api/trends/:topic_id", () => {
  it("hydrates evidence and 404s unknown ids", async () => {
    const t = testContext();
    try {
      await seed(t);
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/trends/t1" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ topic: { topic_id: string }; evidence: { id: string }[]; warnings: number }>();
        expect(body.topic.topic_id).toBe("t1");
        expect(body.evidence.map((e) => e.id).sort()).toEqual(["a1", "a2"]);
        expect(body.warnings).toBe(0);

        const missing = await app.inject({ method: "GET", url: "/api/trends/nope" });
        expect(missing.statusCode).toBe(404);
        expect(missing.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});

describe("GET /api/digest and /api/dates", () => {
  it("returns the digest row and 404s missing dates", async () => {
    const t = testContext();
    try {
      await t.repo.init();
      await t.repo.appendDigest({
        run_date: "2026-09-30",
        run_id: "run-1",
        digest: "One. Two. Three.",
        top_topic_id: "t1",
        topics_count: 2,
        items_count: 3,
        sources_ok: 3,
        sources_total: 3,
        top_categories: [{ category: "Tech", count: 1 }],
        created_at: "2026-09-30T07:00:00.000Z",
        is_latest: true,
      });
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/digest?date=2026-09-30" });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ digest: string }>().digest).toBe("One. Two. Three.");
        const missing = await app.inject({ method: "GET", url: "/api/digest?date=2026-01-01" });
        expect(missing.statusCode).toBe(404);
        const bad = await app.inject({ method: "GET", url: "/api/digest?date=nope" });
        expect(bad.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("lists dates with data, newest first", async () => {
    const t = testContext();
    try {
      await seed(t);
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/dates" });
        expect(res.json<{ dates: string[] }>().dates).toEqual(["2026-09-30", "2026-09-29"]);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
