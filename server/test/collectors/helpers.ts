/**
 * Phase 3 test helpers: fixture loader, fake `fetch` router, CollectContext builder.
 * Contract tests serve *recorded* fixtures through a fake fetch (rule 13 —
 * parsers are written against what the recorded endpoint actually returned).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type { CollectContext, RawItemDraft } from "../../src/collectors/types.js";
import type { ScraplingClient } from "../../src/scraping/client.js";
import { ExtractedPage, type LlmExtractor } from "../../src/llm/extract.js";
import { HttpClient } from "../../src/collectors/http.js";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";

const fixtureDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixture(name: string): string {
  return readFileSync(fixtureDir + name, "utf8");
}

/** JSON fixture as `unknown` — callers cast to their schema (assertion is meaningful). */
export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name));
}

/** Safe URL stringification for fake fetch stubs (RequestInfo has no useful toString). */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface Route {
  /** Substring match against the requested URL. */
  match: string;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** fetch stub: first matching route wins; unmatched → 404. */
export function fakeFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(route.body ?? "", {
        status: route.status ?? 200,
        headers: route.headers ?? {},
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export interface FakeLlmResult {
  title?: string;
  snippet?: string;
  published_at?: string | null;
  entities?: string[];
  language?: string;
  is_article?: boolean;
  /** Throw on extract() to simulate OmniRoute outage. */
  throwError?: boolean;
}

/** LlmExtractor stub (webpage collector). */
export function fakeExtractor(result: FakeLlmResult = {}): LlmExtractor & { calls: number } {
  const state = { calls: 0 };
  return {
    model: "extractor-test",
    get calls() {
      return state.calls;
    },
    extract(): Promise<ReturnType<typeof ExtractedPage.parse>> {
      state.calls += 1;
      if (result.throwError) return Promise.reject(new Error("OmniRoute unreachable"));
      return Promise.resolve(
        ExtractedPage.parse({
          title: result.title ?? "Extracted title",
          snippet: result.snippet ?? "Extracted snippet.",
          published_at: result.published_at ?? null,
          entities: result.entities ?? [],
          language: result.language ?? "en",
          is_article: result.is_article ?? true,
        }),
      );
    },
  };
}

export interface CtxOverrides {
  fetchImpl?: typeof fetch;
  http?: HttpClient;
  llm?: LlmExtractor;
  scraping?: ScraplingClient | null;
  limit?: number;
  config?: Record<string, unknown>;
  geo?: string;
  enablePlaywright?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export function makeCtx(overrides: CtxOverrides = {}): CollectContext {
  const http =
    overrides.http ??
    new HttpClient({
      userAgent: "TrendPulse-Test/1.0",
      // Tests never wait on real gaps or retry backoff.
      limiter: new DomainRateLimiter({ gapMs: 0, sleep: () => Promise.resolve() }),
      sleep: overrides.sleep ?? (() => Promise.resolve()),
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    });
  return {
    runId: "run_test",
    limit: overrides.limit ?? 10,
    niches: ["tech", "ai"],
    geo: overrides.geo ?? "US",
    enablePlaywright: overrides.enablePlaywright ?? false,
    http,
    llm: overrides.llm ?? fakeExtractor(),
    ...(overrides.scraping !== undefined ? { scraping: overrides.scraping } : {}),
    signal: new AbortController().signal,
    log: pino({ level: "silent" }),
    config: overrides.config ?? {},
  };
}

export function names(items: RawItemDraft[]): string[] {
  return items.map((i) => i.title);
}
