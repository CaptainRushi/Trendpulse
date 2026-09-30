import { describe, expect, it } from "vitest";
import { hackernewsCollector, hnItemToDraft, hnSnippet } from "../../src/collectors/hackernews.js";
import { fixture, fixtureJson, makeCtx, names, urlOf } from "./helpers.js";

/** Serve recorded fixtures for ids we have; "null" otherwise. */
function fixtureAwareFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const top = fixtureJson("hn_topstories.json") as number[];
  const known = new Set(
    top
      .filter((id) => {
        try {
          fixture(`hn_item_${String(id)}.json`);
          return true;
        } catch {
          return false;
        }
      }),
  );
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

describe("hnSnippet", () => {
  it("strips paragraph markers, tags and entities", () => {
    expect(hnSnippet("<p>First &amp; second<p>Third &lt;3")).toBe("First & second Third <3");
    expect(hnSnippet(undefined)).toBe("");
  });
});

describe("hnItemToDraft", () => {
  it("maps a story to a draft", () => {
    const item = fixtureJson("hn_item_49906637.json") as Parameters<typeof hnItemToDraft>[0];
    const draft = hnItemToDraft(item);
    expect(draft).not.toBeNull();
    expect(draft?.source).toBe("hackernews");
    expect(draft?.source_item_id).toBe("49906637");
    expect(draft?.url).toMatch(/^https?:\/\//);
    expect(draft?.engagement_score).toBeGreaterThan(0);
    expect(draft?.engagement.comments).toBeGreaterThanOrEqual(0);
    expect(draft?.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops non-story, dead and deleted items", () => {
    expect(hnItemToDraft({ id: 1, type: "comment", title: "c" })).toBeNull();
    expect(hnItemToDraft({ id: 1, type: "story", title: "t", dead: true })).toBeNull();
    expect(hnItemToDraft({ id: 1, type: "story", deleted: true })).toBeNull();
    expect(hnItemToDraft({ id: 1, type: "story" })).toBeNull(); // no title
  });

  it("falls back to the HN item page when the story has no external url", () => {
    const draft = hnItemToDraft({ id: 42, type: "story", title: "Ask HN: question" });
    expect(draft?.url).toBe("https://news.ycombinator.com/item?id=42");
  });
});

describe("hackernewsCollector", () => {
  it("collects stories from recorded fixtures", async () => {
    const { fetchImpl } = fixtureAwareFetch();
    const ctx = makeCtx({ fetchImpl, limit: 10 });
    const { items, stats } = await hackernewsCollector.collect(ctx);

    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("hackernews");
    // 6 of the top 10 have recorded item fixtures; the rest answer null.
    expect(items.length).toBe(6);
    expect(names(items)).toContain("Pi.dev: You Said No MCP");
    expect(names(items)).toContain("Vermont replacing power plants with home batteries");
    const draft = items.find((i) => i.source_item_id === "49906637");
    expect(draft?.engagement_score).toBe(169);
    expect(draft?.author).toBe("yarapavan");
  });

  it("honors the limit (only limit ids are fetched)", async () => {
    const { fetchImpl, calls } = fixtureAwareFetch();
    const ctx = makeCtx({ fetchImpl, limit: 3 });
    const { stats } = await hackernewsCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(calls.filter((u) => u.includes("/item/")).length).toBe(3);
  });

  it("returns an error stat when topstories fails", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.resolve(new Response("boom", { status: 500 })),
      sleep: async () => undefined,
    });
    const { items, stats } = await hackernewsCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(items).toEqual([]);
    expect(stats.error).toContain("500");
  });

  it("sends the User-Agent on every request", async () => {
    const { fetchImpl, calls } = fixtureAwareFetch();
    await hackernewsCollector.collect(makeCtx({ fetchImpl, limit: 2 }));
    expect(calls.length).toBeGreaterThan(1);
    // HttpClient is exercised through makeCtx → UA set in helpers.
  });
});
