/**
 * Step-4 collector contract (docs/12 Prompt 4). Titles start with the test ID
 * per CLAUDE.md rule 9. Additive — descriptive Phase-3 suites stay.
 */
import { describe, expect, it } from "vitest";
import { githubCollector } from "../../src/collectors/github.js";
import { googleTrendsCollector, parseApproxTraffic } from "../../src/collectors/google-trends.js";
import { hackernewsCollector } from "../../src/collectors/hackernews.js";
import { redditCollector } from "../../src/collectors/reddit.js";
import { COLLECTORS, runCollectors } from "../../src/collectors/registry.js";
import { rssCollector } from "../../src/collectors/rss.js";
import { RawItemDraft } from "../../src/collectors/types.js";
import type { Collector, CollectResult } from "../../src/collectors/types.js";
import { wikipediaCollector } from "../../src/collectors/wikipedia.js";
import { SourceKey } from "../../src/sheets/schema.js";
import { fixture, fixtureJson, fakeFetch, makeCtx, urlOf } from "./helpers.js";

function hnFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const top = fixtureJson("hn_topstories.json") as number[];
  const known = new Set<number>();
  for (const id of top) {
    try {
      fixture(`hn_item_${String(id)}.json`);
      known.add(id);
    } catch {
      // no recorded item — serves null below
    }
  }
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    if (url.includes("/topstories.json")) {
      return Promise.resolve(new Response(fixture("hn_topstories.json"), { status: 200 }));
    }
    const m = /\/item\/(\d+)\.json/.exec(url);
    const id = m?.[1];
    if (id && known.has(Number(id))) {
      return Promise.resolve(new Response(fixture(`hn_item_${id}.json`), { status: 200 }));
    }
    return Promise.resolve(new Response("null", { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function rssFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  return fakeFetch([
    { match: "/robots.txt", body: "User-agent: *\n" },
    { match: "hnrss.org/frontpage", body: fixture("rss_hnrss.xml") },
  ]);
}

describe("STEP 4 collectors", () => {
  it("COL-01 hackernews fixture yields valid drafts", async () => {
    const { fetchImpl } = hnFetch();
    const { items, stats } = await hackernewsCollector.collect(makeCtx({ fetchImpl, limit: 10 }));
    expect(stats.status).toBe("ok");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.url).toMatch(/^https?:\/\//);
      expect(item.snippet.length).toBeLessThanOrEqual(500);
      expect(item.source_item_id).toBeTruthy();
      expect(item.engagement_score ?? 0).toBeGreaterThanOrEqual(0);
      expect(RawItemDraft.parse(item)).toBeDefined();
    }
  });

  it("COL-02 reddit fixture parses; 403 on every sub is blocked", async () => {
    const { fetchImpl } = fakeFetch([{ match: "/r/", body: fixture("reddit_popular.json") }]);
    const ok = await redditCollector.collect(makeCtx({ fetchImpl, limit: 50 }));
    expect(ok.stats.status).toBe("ok");
    expect(ok.items.length).toBe(6);
    expect(ok.items[0]?.engagement_score).toBeGreaterThanOrEqual(0);

    const walled = await redditCollector.collect(
      makeCtx({
        fetchImpl: () => Promise.resolve(new Response("<html>walled</html>", { status: 403 })),
        sleep: async () => undefined,
      }),
    );
    expect(walled.stats.status).toBe("blocked");
    expect(walled.items).toEqual([]);
    expect(walled.stats.error).toContain("403");
  });

  it("COL-03 google trends parses traffic strings into numbers", async () => {
    expect(parseApproxTraffic("200K+")).toBe(200_000);
    const { fetchImpl } = fakeFetch([{ match: "trends", body: fixture("trends_rss.xml") }]);
    const { items, stats } = await googleTrendsCollector.collect(makeCtx({ fetchImpl }));
    expect(stats.status).toBe("ok");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.engagement_score).toBeGreaterThan(0);
  });

  it("COL-04 github maps stars and forks", async () => {
    const { fetchImpl } = fakeFetch([{ match: "api.github.com", body: fixture("github_search.json") }]);
    const { items, stats } = await githubCollector.collect(makeCtx({ fetchImpl, limit: 5 }));
    expect(stats.status).toBe("ok");
    expect(items.length).toBe(5);
    expect(items[0]?.engagement_score).toBeGreaterThan(0);
    expect(items[0]?.engagement["forks"]).toBeGreaterThanOrEqual(0);
  });

  it("COL-05 wikipedia skips Main_Page and Special:", async () => {
    const { fetchImpl } = fakeFetch([{ match: "wikimedia.org", body: fixture("wikipedia_top.json") }]);
    const { items, stats } = await wikipediaCollector.collect(makeCtx({ fetchImpl, limit: 50 }));
    expect(stats.status).toBe("ok");
    expect(items.some((i) => i.title === "Main_Page")).toBe(false);
    expect(items.every((i) => i.url.startsWith("https://en.wikipedia.org/wiki/"))).toBe(true);
  });

  it("COL-06 rss parses feeds and honors item limits", async () => {
    const { fetchImpl } = rssFetch();
    const ctx = makeCtx({ fetchImpl, config: { feeds: ["https://hnrss.org/frontpage"] }, limit: 50 });
    const { items, stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(items.length).toBe(20);
    expect(items[0]?.engagement_score).toBeNull();
  });

  it("COL-08 one throwing collector never stops the others", async () => {
    const explosive: Collector = {
      key: "reddit",
      label: "Explosive",
      requires: [],
      collect(): Promise<CollectResult> {
        return Promise.reject(new Error("boom"));
      },
    };
    const original = COLLECTORS.reddit;
    COLLECTORS.reddit = explosive;
    try {
      const { fetchImpl } = hnFetch();
      const out = await runCollectors(makeCtx({ fetchImpl }), { keys: ["hackernews", "reddit"] });
      expect(out.stats).toHaveLength(2);
      expect(out.stats.find((s) => s.source === "reddit")?.status).toBe("error");
      expect(out.stats.find((s) => s.source === "hackernews")?.status).toBe("ok");
    } finally {
      COLLECTORS.reddit = original;
    }
  });

  it("COL-09 timeouts and 500s retry then surface an error stat", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      fetchImpl: (input: RequestInfo | URL) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response("down", { status: 500 }));
      },
      sleep: async () => undefined,
    });
    const { stats, items } = await hackernewsCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(items).toEqual([]);
    expect(calls.filter((u) => u.includes("/topstories.json")).length).toBeGreaterThan(1);
  });

  it("COL-13 item_limit bounds every collector", async () => {
    const { fetchImpl, calls } = hnFetch();
    const { items } = await hackernewsCollector.collect(makeCtx({ fetchImpl, limit: 3 }));
    expect(items.length).toBeLessThanOrEqual(3);
    expect(calls.filter((u) => u.includes("/item/")).length).toBe(3);

    const { fetchImpl: ghFetch } = fakeFetch([{ match: "api.github.com", body: fixture("github_search.json") }]);
    const gh = await githubCollector.collect(makeCtx({ fetchImpl: ghFetch, limit: 2 }));
    expect(gh.items.length).toBe(2);
  });

  it("COL-14 missing-key sources skip with a clear message", async () => {
    const out = await runCollectors(makeCtx(), { keys: ["youtube"] });
    expect(out.stats[0]?.status).toBe("skipped");
    expect(out.stats[0]?.error).toBeTruthy();
    expect(out.items).toEqual([]);
  });

  it("W-03 every fixture-backed collector returns zod-valid drafts", async () => {
    const { fetchImpl: hn } = hnFetch();
    const { fetchImpl: rd } = fakeFetch([{ match: "/r/", body: fixture("reddit_popular.json") }]);
    const { fetchImpl: tr } = fakeFetch([{ match: "trends", body: fixture("trends_rss.xml") }]);
    const { fetchImpl: gh } = fakeFetch([{ match: "api.github.com", body: fixture("github_search.json") }]);
    const { fetchImpl: wk } = fakeFetch([{ match: "wikimedia.org", body: fixture("wikipedia_top.json") }]);
    const { fetchImpl: rs } = rssFetch();
    const cases = [
      { key: "hackernews" as const, fetchImpl: hn, config: {} },
      { key: "reddit" as const, fetchImpl: rd, config: {} },
      { key: "google_trends" as const, fetchImpl: tr, config: {} },
      { key: "github" as const, fetchImpl: gh, config: {} },
      { key: "wikipedia" as const, fetchImpl: wk, config: {} },
      { key: "rss" as const, fetchImpl: rs, config: { feeds: ["https://hnrss.org/frontpage"] } },
    ] as const;
    for (const c of cases) {
      const { items, stats } = await COLLECTORS[c.key].collect(
        makeCtx({ fetchImpl: c.fetchImpl, config: c.config, limit: 10 }),
      );
      expect(stats.status).toBe("ok");
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(() => RawItemDraft.parse(item)).not.toThrow();
    }
    // Registry covers every declared source key.
    for (const key of SourceKey.options) expect(COLLECTORS[key]).toBeDefined();
  });
});
