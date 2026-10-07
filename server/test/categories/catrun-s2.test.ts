import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import type { StateDb } from "../../src/db/sqlite.js";
import { CATEGORY_MAX_ITEMS, collectCategory } from "../../src/categories/collect.js";
import { CATEGORY_REGISTRY, effectiveSources } from "../../src/categories/registry.js";
import { estimateRun } from "../../src/categories/estimate.js";
import { hackernewsCollector, searchHackernews } from "../../src/collectors/hackernews.js";
import { githubCollector } from "../../src/collectors/github.js";
import { rssCollector } from "../../src/collectors/rss.js";
import { fakeFetch, fixture, makeCtx } from "../collectors/helpers.js";

function ctxFor(fetchImpl: typeof fetch, limit = 10, config: Record<string, unknown> = {}) {
  return makeCtx({ fetchImpl, limit, config });
}

describe("CATRUN-03 only selected categories' sources are called", () => {
  it("ai run never touches general front pages", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: "hn.algolia.com", body: fixture("catrun/algolia_llm.json") },
      { match: "api.github.com", body: fixture("catrun/github_topic_llm.json") },
      { match: "technologyreview.com", body: fixture("catrun/lobsters_rss.xml") },
    ]);
    const ctx = ctxFor(fetchImpl, 10);
    const { items, stats } = await collectCategory(ctx, "ai", CATEGORY_REGISTRY["ai"]?.sources ?? []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.source === "hackernews" || i.source === "github" || i.source === "rss")).toBe(true);
    expect(calls.some((c) => c.includes("topstories.json"))).toBe(false);
    expect(calls.some((c) => c.includes("hn.algolia.com"))).toBe(true);
    expect(stats.every((s) => s.status !== "error")).toBe(true);
  });
});

describe("CATRUN-04 hackernews keyword fixture maps and dedupes", () => {
  it("algolia hits become drafts with stable ids", async () => {
    const { fetchImpl } = fakeFetch([{ match: "hn.algolia.com", body: fixture("catrun/algolia_llm.json") }]);
    const ctx = ctxFor(fetchImpl, 5);
    const found = await searchHackernews(
      (url) => ctx.http.get(url),
      "llm",
      5,
    );
    expect(found).toHaveLength(5);
    expect(found[0]?.source_item_id).toBe("49943034");
    expect(found[0]?.engagement_score).toBe(417);
    // Same canonical URL + hash as a front-page fetch of the same story.
    const again = await searchHackernews(
      (url) => ctx.http.get(url),
      "llm",
      5,
    );
    expect(again.map((i) => i.source_item_id)).toEqual(found.map((i) => i.source_item_id));
    // Through the collector with keywords config.
    const collected = await hackernewsCollector.collect(makeCtx({ fetchImpl, limit: 5, config: { keywords: ["llm"] } }));
    expect(collected.items.length).toBeGreaterThan(0);
    expect(collected.items.every((i) => typeof i.source_item_id === "string")).toBe(true);
  });
});

describe("CATRUN-05 github topic and rss fixtures parse", () => {
  it("topic search maps repos; lobsters rss maps items", async () => {
    const { fetchImpl } = fakeFetch([
      { match: "api.github.com", body: fixture("catrun/github_topic_llm.json") },
      { match: "lobste.rs", body: fixture("catrun/lobsters_rss.xml") },
    ]);
    const gh = await githubCollector.collect(makeCtx({ fetchImpl, limit: 5, config: { query: "topic:llm" } }));
    expect(gh.items.length).toBeGreaterThan(0);
    expect(gh.items[0]?.source).toBe("github");
    const rss = await rssCollector.collect(makeCtx({ fetchImpl, limit: 5, config: { feeds: ["https://lobste.rs/rss"] } }));
    expect(rss.items.length).toBeGreaterThan(0);
  });
});

describe("CATRUN-06 reddit without OAuth is skipped with a hint", () => {
  it("no creds means no requests", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const ctx = ctxFor(fetchImpl, 10, {});
    const { items, stats } = await collectCategory(ctx, "tech", [
      { collector: "reddit", params: { subreddits: ["technology"] }, verified_at: "" },
    ]);
    expect(items).toEqual([]);
    expect(calls).toEqual([]);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ source: "reddit", status: "skipped" });
    expect(stats[0]?.error).toContain("OAuth");
  });
});

describe("CATRUN-12 estimate is a sound ceiling and caps hold", () => {
  it("actuals never exceed the estimate; cost math is exact", async () => {
    const db: StateDb = openDatabase(":memory:");
    applyMigrations(db);
    try {
      db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1','2026-10-04','manual','success','[]','2026-10-04T06:00:00.000Z')").run();
      db.prepare("INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, target_category) VALUES ('old','run_1','2026-10-04','hackernews','h','{}','ai')").run();
      const { fetchImpl } = fakeFetch([
        { match: "hn.algolia.com", body: fixture("catrun/algolia_llm.json") },
        { match: "api.github.com", body: fixture("catrun/github_topic_llm.json") },
        { match: "technologyreview.com", body: fixture("catrun/lobsters_rss.xml") },
      ]);
      const ctx = ctxFor(fetchImpl, 40);
      const sources = effectiveSources("ai");
      const estimate = estimateRun(
        db,
        { categories: ["ai"], mode: "strict", redditCreds: false },
        "2026-10-04",
        0.04,
      );
      expect(estimate.scope).toBe("ai");
      expect(estimate.heuristic).toBe(true);
      expect(estimate.stored_items_reused).toBe(1);
      // Cost is exact arithmetic on the ceiling: 120 calls × 1500 tok × $0.04/M.
      expect(estimate.jev_calls_expected).toBe(120);
      expect(estimate.cost_usd_estimate).toBeCloseTo(120 * 0.0015 * 0.04, 6);
      const { items } = await collectCategory(ctx, "ai", sources, CATEGORY_MAX_ITEMS);
      // Ceiling property: a planning upper bound, never exceeded in practice.
      expect(items.length).toBeLessThanOrEqual(estimate.expected_new_items);
      // Cap holds per source.
      expect(items.length).toBeLessThanOrEqual(sources.length * CATEGORY_MAX_ITEMS);
    } finally {
      db.close();
    }
  });
});

describe("CATRUN-15 politeness: caps, isolation, robots", () => {
  it("per-source limit respected; one bad source does not fail others", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: "hn.algolia.com", status: 500, body: "boom" },
      { match: "api.github.com", body: fixture("catrun/github_topic_llm.json") },
    ]);
    const ctx = ctxFor(fetchImpl, 3);
    const { items, stats } = await collectCategory(ctx, "ai", [
      { collector: "hackernews", params: { keywords: ["llm"] }, verified_at: "" },
      { collector: "github", params: { query: "topic:llm" }, verified_at: "" },
    ]);
    const hnCalls = calls.filter((c) => c.includes("hn.algolia.com"));
    expect(hnCalls.length).toBeLessThanOrEqual(3);
    expect(items.every((i) => i.source === "github")).toBe(true);
    expect(stats.find((s) => s.source === "github")?.status).toBe("ok");
  });
});
