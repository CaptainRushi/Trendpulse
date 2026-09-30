import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, type EtagCacheStore } from "../../src/collectors/http.js";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";
import { urlOf } from "./helpers.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** fetch stub with per-URL scripted responses; records every call. */
function scriptedFetch(
  handler: (url: string, init: RequestInit | undefined, callNo: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, calls.length));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(
  fetchImpl: typeof fetch,
  opts: { sleep?: (ms: number) => Promise<void>; cache?: EtagCacheStore } = {},
): HttpClient {
  return new HttpClient({
    userAgent: "TrendPulse-Test/1.0",
    fetchImpl,
    limiter: new DomainRateLimiter({ gapMs: 0 }),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.cache ? { cache: opts.cache } : {}),
  });
}

describe("HttpClient", () => {
  it("sends the configured User-Agent", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response("ok"));
    await client(fetchImpl).get("https://a.com/x");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("TrendPulse-Test/1.0");
  });

  it("returns status, headers and body on 200", async () => {
    const { fetchImpl } = scriptedFetch(
      () => new Response("hello", { status: 200, headers: { "x-test": "1" } }),
    );
    const res = await client(fetchImpl).get("https://a.com/x");
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.headers["x-test"]).toBe("1");
    expect(res.notModified).toBe(false);
  });

  it("retries 500 with backoff then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = scriptedFetch((url, init, n) =>
      url.includes("/flaky") && n < 3 ? new Response("err", { status: 500 }) : new Response("ok"),
    );
    const res = await client(fetchImpl, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).get("https://a.com/flaky");
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([1000, 2000]); // exponential backoff base 1000
  });

  it("gives up after maxAttempts and throws HttpError", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response("err", { status: 503 }));
    await expect(
      client(fetchImpl, { sleep: async () => undefined }).get("https://a.com/down"),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(3); // maxAttempts default 3
  });

  it("honors Retry-After on 429", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = scriptedFetch((url, init, n) =>
      n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : new Response("ok"),
    );
    const res = await client(fetchImpl, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).get("https://a.com/limited");
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([2000]);
    expect(calls.length).toBe(2);
  });

  it("does not retry 4xx (except 429)", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response("nope", { status: 404 }));
    const res = await client(fetchImpl).get("https://a.com/missing");
    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  it("times out hung requests via AbortSignal", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as typeof fetch;
    const sleeps: number[] = [];
    await expect(
      client(fetchImpl, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }).get("https://a.com/hang", { timeoutMs: 10 }),
    ).rejects.toThrow();
    // retried (network errors retry) — proves the abort triggered retries
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("sends conditional headers and treats 304 as notModified", async () => {
    const cache: EtagCacheStore = {
      get: async () => ({ etag: '"v1"', last_modified: null }),
      set: async () => undefined,
    };
    const { fetchImpl, calls } = scriptedFetch(() => new Response(null, { status: 304 }));
    const res = await client(fetchImpl, { cache }).get("https://a.com/feed", { etag: true });
    expect(res.notModified).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('"v1"');
  });

  it("stores etag from 200 responses when etag option is set", async () => {
    const stored: Record<string, string | null> = {};
    const cache: EtagCacheStore = {
      get: async () => null,
      set: async (url, etag) => {
        stored[url] = etag;
      },
    };
    const { fetchImpl } = scriptedFetch(
      () => new Response("body", { status: 200, headers: { etag: '"v2"' } }),
    );
    await client(fetchImpl, { cache }).get("https://a.com/feed", { etag: true });
    expect(stored["https://a.com/feed"]).toBe('"v2"');
  });

  it("fetches robots.txt once per origin and blocks disallowed URLs", async () => {
    const { fetchImpl, calls } = scriptedFetch((url) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private", { status: 200 });
      }
      return new Response("page", { status: 200 });
    });
    const http = client(fetchImpl);

    const blocked = await http.get("https://a.com/private/page", { robots: true });
    expect(blocked.robotsBlocked).toBe(true);
    expect(blocked.status).toBe(403);
    // page itself never fetched
    expect(calls.some((c) => c.url === "https://a.com/private/page")).toBe(false);

    const allowed = await http.get("https://a.com/public", { robots: true });
    expect(allowed.status).toBe(200);
    // robots.txt fetched exactly once for the origin
    expect(calls.filter((c) => c.url.endsWith("/robots.txt")).length).toBe(1);
  });

  it("allows when robots.txt is missing (404)", async () => {
    const { fetchImpl } = scriptedFetch((url) =>
      url.endsWith("/robots.txt")
        ? new Response("nope", { status: 404 })
        : new Response("page", { status: 200 }),
    );
    const res = await client(fetchImpl).get("https://new.com/anything", { robots: true });
    expect(res.status).toBe(200);
    expect(res.robotsBlocked).toBeUndefined();
  });

  it("postForm sends form body and content-type", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response('{"access_token":"t"}', { status: 200 }));
    const res = await client(fetchImpl).postForm(
      "https://auth.com/token",
      "grant_type=client_credentials",
      { headers: { authorization: "Basic abc" } },
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe("grant_type=client_credentials");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.authorization).toBe("Basic abc");
    expect(headers["user-agent"]).toBe("TrendPulse-Test/1.0");
  });

  it("gap option spaces same-domain requests without serializing domains", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response("ok"));
    const http = new HttpClient({
      userAgent: "UA",
      fetchImpl,
      limiter: new DomainRateLimiter({ gapMs: 50, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
    });
    const t0 = Date.now();
    await Promise.all([http.get("https://a.com/1"), http.get("https://b.com/1")]);
    const elapsed = Date.now() - t0;
    expect(calls.length).toBe(2);
    expect(elapsed).toBeLessThan(40); // different domains → no gap wait
  });
});
