import { describe, expect, it } from "vitest";
import {
  googleTrendsCollector,
  parseApproxTraffic,
  parseTrendsRss,
} from "../../src/collectors/google-trends.js";
import { fixture, makeCtx, urlOf } from "./helpers.js";

describe("parseApproxTraffic", () => {
  it("parses plain and suffixed values", () => {
    expect(parseApproxTraffic("2000+")).toBe(2000);
    expect(parseApproxTraffic("50K+")).toBe(50_000);
    expect(parseApproxTraffic("1.5M+")).toBe(1_500_000);
    expect(parseApproxTraffic("2B+")).toBe(2_000_000_000);
    expect(parseApproxTraffic("700")).toBe(700);
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseApproxTraffic("")).toBeNull();
    expect(parseApproxTraffic(null)).toBeNull();
    expect(parseApproxTraffic("lots+")).toBeNull();
  });
});

describe("parseTrendsRss (recorded fixture)", () => {
  it("extracts items with namespaced ht: fields", () => {
    const items = parseTrendsRss(fixture("trends_rss.xml"));
    expect(items.length).toBe(10);
    const first = items[0];
    expect(first?.title).toBeTruthy();
    expect(first?.approxTraffic).toMatch(/^\d/);
    expect(first?.newsUrl).toMatch(/^https:\/\//);
    expect(first?.pubDate).toBeTruthy();
  });

  it("handles an empty/self-closing description without crashing", () => {
    const items = parseTrendsRss(fixture("trends_rss.xml"));
    for (const item of items) expect(item.title.length).toBeGreaterThan(0);
  });
});

describe("googleTrendsCollector", () => {
  it("collects drafts from the recorded feed", async () => {
    const ctx = makeCtx({
      fetchImpl: () =>
        Promise.resolve(new Response(fixture("trends_rss.xml"), { status: 200 })),
    });
    const { items, stats } = await googleTrendsCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("google_trends");
    expect(items.length).toBe(10);
    expect(items[0]?.engagement_score).toBeGreaterThan(0);
    // prefers the news article URL over the shared trends landing link
    expect(items[0]?.url).toMatch(/^https:\/\//);
    expect(items[0]?.published_at).toMatch(/^\d{4}-/);
  });

  it("honors the limit", async () => {
    const ctx = makeCtx({
      fetchImpl: () =>
        Promise.resolve(new Response(fixture("trends_rss.xml"), { status: 200 })),
      limit: 3,
    });
    const { items } = await googleTrendsCollector.collect(ctx);
    expect(items.length).toBe(3);
  });

  it("requests the configured geo", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      fetchImpl: (input: RequestInfo | URL) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response(fixture("trends_rss.xml"), { status: 200 }));
      },
      geo: "DE",
    });
    await googleTrendsCollector.collect(ctx);
    expect(calls[0]).toContain("geo=DE");
  });

  it("returns an error stat on non-200", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.resolve(new Response("no", { status: 403 })),
    });
    const { stats, items } = await googleTrendsCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(items).toEqual([]);
  });
});
