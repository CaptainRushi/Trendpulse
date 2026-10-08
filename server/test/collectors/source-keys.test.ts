/**
 * COL-14/COL-15: key-gated platforms. Env keys reach collectors (they never
 * did — only config_json arrived); youtube/producthunt skip honestly
 * without keys. Draft shapes below are synthetic (no key = no recording).
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { envSourceConfig } from "../../src/collectors/registry.js";
import { collectCategory } from "../../src/categories/collect.js";
import { producthuntCollector, producthuntDraft } from "../../src/collectors/producthunt.js";
import { youtubeCollector, youtubeDraft } from "../../src/collectors/youtube.js";
import { fixture, makeCtx, urlOf } from "./helpers.js";

describe("envSourceConfig maps env keys to source configs", () => {
  it("sets only the keys present in env", () => {
    expect(envSourceConfig(loadConfig({}))).toEqual({});
    const full = envSourceConfig(
      loadConfig({
        GITHUB_TOKEN: "gh",
        REDDIT_CLIENT_ID: "id",
        REDDIT_CLIENT_SECRET: "secret",
        YOUTUBE_API_KEY: "yt",
        PRODUCTHUNT_TOKEN: "ph",
      }),
    );
    expect(full).toEqual({
      github_token: "gh",
      reddit_client_id: "id",
      reddit_client_secret: "secret",
      youtube_api_key: "yt",
      producthunt_token: "ph",
    });
    // Half a reddit pair is no pair (matches the collector's own check).
    expect(envSourceConfig(loadConfig({ REDDIT_CLIENT_ID: "id" }))).toEqual({});
  });
});

describe("collectCategory merges env keys into every collector", () => {
  it("github runs authenticated when the env token exists", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") ?? "" });
      if (url.includes("api.github.com")) {
        return new Response(fixture("catrun/github_topic_llm.json"), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const ctx = makeCtx({ fetchImpl, limit: 5 });
    const { items } = await collectCategory(
      ctx,
      "ai",
      [{ collector: "github", params: { query: "topic:llm" }, verified_at: "" }],
      5,
      envSourceConfig(loadConfig({ GITHUB_TOKEN: "gh-marker" })),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.url.includes("api.github.com") && s.auth === "Bearer gh-marker")).toBe(true);
  });
});

describe("COL-14 missing keys skip with actionable messages", () => {
  it("youtube/producthunt report skipped, never error, without keys", async () => {
    const ctx = makeCtx({});
    const yt = await youtubeCollector.collect(ctx);
    expect(yt.stats.status).toBe("skipped");
    expect(yt.stats.error).toBe("Needs YOUTUBE_API_KEY");
    expect(yt.items).toEqual([]);
    const ph = await producthuntCollector.collect(ctx);
    expect(ph.stats.status).toBe("skipped");
    expect(ph.stats.error).toBe("Needs PRODUCTHUNT_TOKEN");
    expect(ph.items).toEqual([]);
    expect(youtubeCollector.requires).toEqual(["YOUTUBE_API_KEY"]);
    expect(producthuntCollector.requires).toEqual(["PRODUCTHUNT_TOKEN"]);
  });
});

describe("COL-15 youtube/producthunt draft mapping (synthetic records)", () => {
  it("video maps to watch url with views primary", () => {
    const draft = youtubeDraft({
      id: "abc123",
      snippet: { title: "Keynote", description: "Desc", publishedAt: "2026-10-07T00:00:00Z", channelTitle: "Chan" },
      statistics: { viewCount: "1000", likeCount: "10", commentCount: "2" },
    });
    expect(draft.source).toBe("youtube");
    expect(draft.url).toBe("https://www.youtube.com/watch?v=abc123");
    expect(draft.engagement_score).toBe(1000);
    expect(draft.author).toBe("Chan");
  });

  it("post maps to product url with votes primary", () => {
    const draft = producthuntDraft({
      id: "p1",
      name: "Widget",
      tagline: "Does things",
      url: null,
      slug: "widget",
      votesCount: 42,
      commentsCount: 3,
      createdAt: "2026-10-07T00:00:00Z",
      user: { name: "Founder" },
    });
    expect(draft.source).toBe("producthunt");
    expect(draft.url).toBe("https://www.producthunt.com/posts/widget");
    expect(draft.engagement_score).toBe(42);
  });
});
