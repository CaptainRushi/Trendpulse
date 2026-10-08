/** COL-15: dev.to collector against the recorded top-week fixture. */
import { describe, expect, it } from "vitest";
import { devtoCollector, devtoDraft, devtoUrl } from "../../src/collectors/devto.js";
import { fixture, makeCtx, urlOf } from "./helpers.js";

function devtoFetch(body: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("COL-15 dev.to top articles", () => {
  it("maps the recorded fixture with reactions/comments and stable ids", async () => {
    const { fetchImpl, calls } = devtoFetch(fixture("devto-top.json"));
    const ctx = makeCtx({ fetchImpl, limit: 5 });
    const { items, stats } = await devtoCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("devto");
    expect(items).toHaveLength(5);
    expect(items[0]?.source_item_id).toBe("4781665");
    expect(items.every((i) => i.url.startsWith("https://dev.to/"))).toBe(true);
    expect(items[0]?.engagement_score).toBe(246);
    expect(items[0]?.engagement.comments).toBe(157);
    expect(items[0]?.author).toBe("Giorgi Kobaidze");
    expect(calls.some((c) => c.includes("dev.to/api/articles?top=7"))).toBe(true);
  });

  it("caps per_page at the run limit and fails soft on HTTP errors", async () => {
    expect(devtoUrl(200)).toContain("per_page=100");
    const down = await devtoCollector.collect(makeCtx({ fetchImpl: devtoFetch("boom", 500).fetchImpl }));
    expect(down.stats.status).toBe("error");
    expect(down.items).toEqual([]);
  });

  it("devtoDraft tolerates sparse records", () => {
    const draft = devtoDraft({ id: 1, title: "T", url: "https://dev.to/x/y" });
    expect(draft.source_item_id).toBe("1");
    expect(draft.author).toBeNull();
    expect(draft.engagement_score).toBe(0);
  });
});
