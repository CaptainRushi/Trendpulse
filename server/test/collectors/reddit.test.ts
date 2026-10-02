import { describe, expect, it } from "vitest";
import {
  configuredSubreddits,
  redditCollector,
  redditPostToDraft,
} from "../../src/collectors/reddit.js";
import { fixture, fixtureJson, makeCtx, names, urlOf } from "./helpers.js";
import type { RedditListing } from "../../src/collectors/reddit.js";

const listing = (): RedditListing => fixtureJson("reddit_popular.json") as RedditListing;

describe("reddit fixture provenance", () => {
  it("follows the documented Listing/t3 schema (constructed — live blocked)", () => {
    const data = listing();
    expect(data.kind).toBe("Listing");
    const child = data.data.children[0];
    expect(child?.kind).toBe("t3");
    expect(typeof child?.data.id).toBe("string");
    expect(typeof child?.data.title).toBe("string");
    expect(typeof child?.data.score).toBe("number");
    expect(typeof child?.data.created_utc).toBe("number");
    expect(typeof child?.data.permalink).toBe("string");
  });
});

describe("configuredSubreddits", () => {
  it("defaults to r/popular", () => {
    expect(configuredSubreddits({})).toEqual(["popular"]);
  });
  it("uses configured names", () => {
    expect(configuredSubreddits({ subreddits: ["technology", "science"] })).toEqual([
      "technology",
      "science",
    ]);
  });
  it("ignores empty/malformed entries", () => {
    expect(configuredSubreddits({ subreddits: ["",  "  ", "ai"] })).toEqual(["ai"]);
    expect(configuredSubreddits({ subreddits: [1, 2] })).toEqual(["popular"]);
  });
});

describe("redditPostToDraft", () => {
  it("uses the outbound url for link posts", () => {
    const post = listing().data.children[0]!.data;
    const draft = redditPostToDraft(post);
    expect(draft.url).toBe(post.url);
    expect(draft.engagement_score).toBe(post.score);
    expect(draft.engagement.comments).toBe(post.num_comments);
    expect(draft.published_at).toBe(new Date(post.created_utc * 1000).toISOString());
  });

  it("falls back to the permalink for self posts", () => {
    const selfPost = listing().data.children[1]!.data; // url is the reddit permalink
    const draft = redditPostToDraft(selfPost);
    expect(draft.url).toBe(`https://www.reddit.com${selfPost.permalink}`);
    expect(draft.snippet.length).toBeGreaterThan(0);
  });
});

function listingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    calls.push(urlOf(input));
    return Promise.resolve(new Response(fixture("reddit_popular.json"), { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("redditCollector", () => {
  it("collects posts from the constructed fixture", async () => {
    const { fetchImpl } = listingFetch();
    const ctx = makeCtx({ fetchImpl, limit: 50 });
    const { items, stats } = await redditCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("reddit");
    // 8 posts − 1 stickied − 1 over_18 = 6
    expect(items.length).toBe(6);
    expect(names(items)).not.toContain("Weekly discussion thread");
    expect(names(items)).not.toContain("NSFW example post that should be filtered");
    expect(names(items)).toContain(
      "Open-source AI model matches GPT-4 on reasoning benchmarks",
    );
  });

  it("requests r/popular by default", async () => {
    const { fetchImpl, calls } = listingFetch();
    await redditCollector.collect(makeCtx({ fetchImpl }));
    expect(calls[0]).toContain("/r/popular.json");
  });

  it("fans out over configured subreddits", async () => {
    const { fetchImpl, calls } = listingFetch();
    const ctx = makeCtx({
      fetchImpl,
      config: { subreddits: ["technology", "science"] },
      limit: 50,
    });
    const { items, stats } = await redditCollector.collect(ctx);
    expect(calls.some((c) => c.includes("/r/technology.json"))).toBe(true);
    expect(calls.some((c) => c.includes("/r/science.json"))).toBe(true);
    expect(stats.status).toBe("ok");
    expect(items.length).toBe(12); // 6 valid posts × 2 subreddits
  });

  it("returns a blocked stat when every subreddit is walled", async () => {
    const ctx = makeCtx({
      fetchImpl: () =>
        Promise.resolve(new Response("<html>blocked</html>", { status: 403 })),
      sleep: async () => undefined,
    });
    const { stats, items } = await redditCollector.collect(ctx);
    expect(stats.status).toBe("blocked");
    expect(items).toEqual([]);
    expect(stats.error).toContain("403");
  });

  it("reports partial failure but keeps good items", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      fetchImpl: (input: RequestInfo | URL) => {
        const url = urlOf(input);
        calls.push(url);
        if (url.includes("/r/science")) {
          return Promise.resolve(new Response("blocked", { status: 403 }));
        }
        return Promise.resolve(new Response(fixture("reddit_popular.json"), { status: 200 }));
      },
      config: { subreddits: ["technology", "science"] },
      sleep: async () => undefined,
    });
    const { items, stats } = await redditCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(items.length).toBeGreaterThan(0);
  });
});
