import { describe, expect, it } from "vitest";
import { configuredFeeds, rssCollector } from "../../src/collectors/rss.js";
import { HttpClient } from "../../src/collectors/http.js";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";
import { fixture, makeCtx, urlOf } from "./helpers.js";

describe("configuredFeeds", () => {
  it("accepts http/https urls only", () => {
    expect(
      configuredFeeds({ feeds: ["https://a.com/rss", "http://b.com/f", "ftp://x.com/f"] }),
    ).toEqual(["https://a.com/rss", "http://b.com/f"]);
  });
  it("skips malformed entries instead of failing", () => {
    expect(configuredFeeds({ feeds: ["not a url", 42, "https://ok.com/x"] })).toEqual([
      "https://ok.com/x",
    ]);
    expect(configuredFeeds({})).toEqual([]);
    expect(configuredFeeds({ feeds: "https://nope" })).toEqual([]);
  });
});

function feedFetch(body: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return Promise.resolve(new Response("User-agent: *", { status: 200 }));
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("rssCollector", () => {
  it("skips cleanly when no feeds are configured", async () => {
    const { items, stats } = await rssCollector.collect(makeCtx());
    expect(stats.status).toBe("skipped");
    expect(stats.error).toContain("no feed URLs");
    expect(items).toEqual([]);
  });

  it("parses the recorded hnrss feed", async () => {
    const { fetchImpl, calls } = feedFetch(fixture("rss_hnrss.xml"));
    const ctx = makeCtx({ fetchImpl, config: { feeds: ["https://hnrss.org/frontpage"] }, limit: 50 });
    const { items, stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("rss");
    expect(items.length).toBe(20); // all recorded items, limit 50
    expect(items[0]?.title).toBeTruthy();
    expect(items[0]?.url).toMatch(/^https?:\/\//);
    expect(items[0]?.engagement_score).toBeNull();
    // rank position is the signal for rss (Phase 4 fallback)
    expect(items[0]?.engagement.rank).toBe(0);
    // robots.txt for the origin is fetched first, then the feed itself
    expect(calls).toContain("https://hnrss.org/frontpage");
    expect(calls[0]).toBe("https://hnrss.org/robots.txt");
  });

  it("sends conditional headers for the etag cache", async () => {
    let sawConditional = false;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["if-none-match"]) sawConditional = true;
      if (urlOf(input).endsWith("/robots.txt")) {
        return Promise.resolve(new Response("User-agent: *", { status: 200 }));
      }
      return Promise.resolve(
        new Response(fixture("rss_hnrss.xml"), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
      );
    }) as typeof fetch;

    const cache = {
      get: async (url: string) =>
        url === "https://feeds.com/rss" ? { etag: '"v1"', last_modified: null } : null,
      set: async () => undefined,
    };
    const ctx = makeCtx({
      http: new HttpClient({
        userAgent: "TrendPulse-Test/1.0",
        fetchImpl,
        cache,
        limiter: new DomainRateLimiter({ gapMs: 0 }),
      }),
      config: { feeds: ["https://feeds.com/rss"] },
    });

    const first = await rssCollector.collect(ctx);
    expect(first.stats.status).toBe("ok");
    expect(sawConditional).toBe(true);
  });

  it("treats a 304 as zero new items, not an error", async () => {
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      if (urlOf(input).endsWith("/robots.txt")) {
        return Promise.resolve(new Response("User-agent: *", { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 304 }));
    }) as typeof fetch;
    const cache = {
      get: async () => ({ etag: '"v1"', last_modified: null }),
      set: async () => undefined,
    };
    const ctx = makeCtx({
      http: new HttpClient({
        userAgent: "TrendPulse-Test/1.0",
        fetchImpl,
        cache,
        limiter: new DomainRateLimiter({ gapMs: 0 }),
      }),
      config: { feeds: ["https://feeds.com/rss"] },
    });
    const { items, stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(items).toEqual([]); // not modified → nothing new
  });

  it("skips a robots-disallowed feed with a log", async () => {
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input);
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("User-agent: *\nDisallow: /feed", { status: 200 }));
      }
      return Promise.resolve(new Response(fixture("rss_hnrss.xml"), { status: 200 }));
    }) as typeof fetch;
    const ctx = makeCtx({
      fetchImpl,
      config: { feeds: ["https://blocked.com/feed"] },
    });
    const { items, stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("error"); // nothing collected and the feed was blocked
    expect(stats.error).toContain("robots.txt disallowed");
    expect(items).toEqual([]);
  });

  it("returns an error stat when the feed is unreachable", async () => {
    const { fetchImpl } = feedFetch("nope", 500);
    const ctx = makeCtx({
      fetchImpl,
      sleep: async () => undefined,
      config: { feeds: ["https://down.com/rss"] },
    });
    const { stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("error");
  });

  it("never leaks query strings (tokens) into errors or logs", async () => {
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input);
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("User-agent: *\nDisallow: /feed", { status: 200 }));
      }
      return Promise.resolve(new Response(fixture("rss_hnrss.xml"), { status: 200 }));
    }) as typeof fetch;
    const ctx = makeCtx({
      fetchImpl,
      config: { feeds: ["https://blocked.com/feed?token=secret-token"] },
    });
    const { stats } = await rssCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("https://blocked.com/feed[…]");
    expect(stats.error).not.toContain("secret-token");
  });
});
