import { describe, expect, it } from "vitest";
import {
  articleUrl,
  isSpecialArticle,
  previousUtcDay,
  wikipediaCollector,
} from "../../src/collectors/wikipedia.js";
import { fixture, fixtureJson, makeCtx, urlOf } from "./helpers.js";

interface PageviewsFixture {
  items: { articles: { article: string; views: number; rank: number }[] }[];
}

describe("previousUtcDay", () => {
  it("returns the previous UTC calendar day", () => {
    expect(previousUtcDay(new Date("2026-09-30T12:00:00Z"))).toBe("2026-09-29");
    expect(previousUtcDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
    expect(previousUtcDay(new Date("2026-01-01T23:59:59Z"))).toBe("2025-12-31");
  });
});

describe("isSpecialArticle", () => {
  it("skips main/special pages per TRD", () => {
    expect(isSpecialArticle("Main_Page")).toBe(true);
    expect(isSpecialArticle("Special:Search")).toBe(true);
    expect(isSpecialArticle("special:search")).toBe(true);
    expect(isSpecialArticle("Wikipedia:Featured_pictures")).toBe(true);
    expect(isSpecialArticle("File:Cat.jpg")).toBe(true);
    expect(isSpecialArticle("Case_Keenum")).toBe(false);
    expect(isSpecialArticle("Superconductor")).toBe(false);
  });
});

describe("articleUrl", () => {
  it("builds a readable wiki URL", () => {
    expect(articleUrl("Case_Keenum")).toBe("https://en.wikipedia.org/wiki/Case_Keenum");
    expect(articleUrl("A B")).toBe("https://en.wikipedia.org/wiki/A_B");
  });
});

describe("wikipediaCollector", () => {
  it("collects top articles, skipping special pages", async () => {
    const recorded = fixtureJson("wikipedia_top.json") as PageviewsFixture;
    const specialCount = recorded.items[0]!.articles.filter((a) => isSpecialArticle(a.article)).length;
    expect(specialCount).toBeGreaterThan(0); // fixture must contain skip cases

    const ctx = makeCtx({
      fetchImpl: () =>
        Promise.resolve(new Response(fixture("wikipedia_top.json"), { status: 200 })),
      limit: 50,
    });
    const { items, stats } = await wikipediaCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("wikipedia");
    expect(items.length).toBe(50);
    expect(items.some((i) => i.title === "Main_Page")).toBe(false);
    expect(items.some((i) => i.title === "Special:Search")).toBe(false);
    // rank 3 in the fixture is the first non-special article
    expect(items[0]?.title).toBe("Case Keenum");
    expect(items[0]?.engagement_score).toBe(893057);
    expect(items[0]?.url).toBe("https://en.wikipedia.org/wiki/Case_Keenum");
  });

  it("requests the previous UTC day", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      fetchImpl: (input: RequestInfo | URL) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response(fixture("wikipedia_top.json"), { status: 200 }));
      },
    });
    await wikipediaCollector.collect(ctx);
    expect(calls[0]).toMatch(/\/\d{4}-\d{2}-\d{2}\/all$/);
    expect(calls[0]).toContain("en.wikipedia");
  });

  it("returns an error stat on non-200", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.resolve(new Response("no", { status: 429 })),
      sleep: async () => undefined,
    });
    const { stats } = await wikipediaCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("429");
  });
});
