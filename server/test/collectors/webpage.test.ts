import { describe, expect, it } from "vitest";
import { configuredPages, extractReadable, webpageCollector } from "../../src/collectors/webpage.js";
import { fixture, fakeExtractor, makeCtx, urlOf } from "./helpers.js";

describe("configuredPages", () => {
  it("accepts http/https only, skips malformed", () => {
    expect(configuredPages({ pages: ["https://a.com/p", "javascript:alert(1)", "bad"] })).toEqual([
      "https://a.com/p",
    ]);
    expect(configuredPages({})).toEqual([]);
  });
});

describe("extractReadable (recorded page fixture)", () => {
  it("extracts a substantial article body", () => {
    const out = extractReadable(fixture("webpage_article.html"), "https://example.com/article");
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeGreaterThan(500);
    expect(out!.title.length).toBeGreaterThan(0);
  });

  it("returns null for navigation-only HTML", () => {
    const nav = "<html><body><nav><a href='/'>Home</a></nav></body></html>";
    expect(extractReadable(nav, "https://example.com")).toBeNull();
  });
});

function pageFetch(html: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) {
      return Promise.resolve(new Response("User-agent: *", { status: 200 }));
    }
    return Promise.resolve(new Response(html, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("webpageCollector", () => {
  it("skips cleanly when no pages are configured", async () => {
    const { items, stats } = await webpageCollector.collect(makeCtx());
    expect(stats.status).toBe("skipped");
    expect(stats.error).toContain("no page URLs");
    expect(items).toEqual([]);
  });

  it("extracts an article via Readability + LLM verdict", async () => {
    const { fetchImpl } = pageFetch(fixture("webpage_article.html"));
    const llm = fakeExtractor({
      title: "Komorebi explained",
      snippet: "A short summary of the article.",
      language: "en",
      is_article: true,
    });
    const ctx = makeCtx({
      fetchImpl,
      llm,
      config: { pages: ["https://example.com/komorebi"] },
    });
    const { items, stats } = await webpageCollector.collect(ctx);

    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("webpage");
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe("Komorebi explained");
    expect(items[0]?.snippet).toBe("A short summary of the article.");
    expect(items[0]?.language).toBe("en");
    expect(items[0]?.extraction_model).toBe("extractor-test");
    expect(llm.calls).toBe(1);
  });

  it("drops the page when the LLM says is_article=false", async () => {
    const { fetchImpl } = pageFetch(fixture("webpage_article.html"));
    const llm = fakeExtractor({ is_article: false });
    const ctx = makeCtx({
      fetchImpl,
      llm,
      config: { pages: ["https://example.com/cookie-wall"] },
    });
    const { items, stats } = await webpageCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(items).toEqual([]);
    expect(llm.calls).toBe(1); // verdict still consumed
  });

  it("skips a robots-disallowed page with a log", async () => {
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input);
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(
          new Response("User-agent: *\nDisallow: /private", { status: 200 }),
        );
      }
      return Promise.resolve(new Response("<html><body>secret</body></html>", { status: 200 }));
    }) as typeof fetch;
    const ctx = makeCtx({
      fetchImpl,
      config: { pages: ["https://example.com/private/page"] },
    });
    const { items, stats } = await webpageCollector.collect(ctx);
    // blocked before extraction: nothing collected, error recorded
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("robots.txt disallowed");
    expect(items).toEqual([]);
  });

  it("OmniRoute outage surfaces as an error stat, never throws", async () => {
    const { fetchImpl } = pageFetch(fixture("webpage_article.html"));
    const llm = fakeExtractor({ throwError: true });
    const ctx = makeCtx({
      fetchImpl,
      llm,
      config: { pages: ["https://example.com/a", "https://example.com/b"] },
    });
    const { items, stats } = await webpageCollector.collect(ctx);
    // Every page failed extraction → honest error stat (registry isolation
    // keeps the run going; APP_FLOW shows this as a banner, not a crash).
    expect(stats.status).toBe("error");
    expect(items).toEqual([]);
    expect(llm.calls).toBe(2);
  });

  it("returns an error stat when the page HTTP fails", async () => {
    const { fetchImpl } = pageFetch("gone", 404);
    const ctx = makeCtx({ fetchImpl, config: { pages: ["https://example.com/404"] } });
    const { stats } = await webpageCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("404");
  });
});
