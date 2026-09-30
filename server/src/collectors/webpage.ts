/**
 * webpage — user-configured URLs (config_json.pages) → fetch (robots gate) →
 * Readability main-text extract → OmniRoute LLM extraction → `is_article`
 * gate (TRD §4.2, §6). Playwright fallback behind ENABLE_PLAYWRIGHT when the
 * page needs JS rendering (dynamic import; not installed by default).
 */
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import pLimit from "p-limit";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { httpPing, needsConfig } from "./ping.js";

/** Configured page URLs (http/https only). */
export function configuredPages(config: Record<string, unknown>): string[] {
  const raw = config.pages;
  if (!Array.isArray(raw)) return [];
  const urls: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    try {
      const u = new URL(p.trim());
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.toString());
    } catch {
      // skip malformed entry
    }
  }
  return urls;
}

/** Readability on a DOM → { text, title } | null when no article body. */
export function extractReadable(html: string, url: string): { text: string; title: string } | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent) return null;
    const text = article.textContent.replace(/\s+/g, " ").trim();
    return text.length >= 200 ? { text, title: (article.title ?? "").trim() } : null;
  } catch {
    return null;
  }
}

/** LLM verdict gate: skip nav/cookie/error pages (TRD extractor contract). */

export const webpageCollector: Collector = {
  key: "webpage",
  label: "Web pages",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    const [first] = configuredPages(ctx.config);
    if (!first) return needsConfig("no page URLs configured (sources.config_json.pages)");
    return httpPing(ctx.http, first);
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], status: "ok" | "error" | "skipped", error: string | null = null): CollectResult => ({
      items,
      stats: { source: "webpage", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    const pages = configuredPages(ctx.config);
    if (pages.length === 0) {
      return finish([], "skipped", "no page URLs configured (sources.config_json.pages)");
    }

    const items: RawItemDraft[] = [];
    const errors: string[] = [];
    const limit = pLimit(3);

    const results = await Promise.all(
      pages.map((url) =>
        limit(async (): Promise<RawItemDraft | null> => {
          try {
            let html = "";
            const res = await ctx.http.get(url, { etag: true, robots: true });
            if (res.robotsBlocked) {
              ctx.log.warn({ url }, "webpage: robots.txt disallows this URL, skipped");
              errors.push(`${url}: robots.txt disallowed`);
              return null;
            }
            if (res.notModified) return null;
            if (res.status !== 200) {
              errors.push(`${url}: HTTP ${String(res.status)}`);
              return null;
            }
            html = res.text;

            let readable = extractReadable(html, url);
            if (!readable && ctx.enablePlaywright) {
              readable = await renderWithPlaywright(ctx, url);
            }
            if (!readable) {
              ctx.log.debug({ url }, "webpage: no readable article body");
              return null;
            }

            const extracted = await ctx.llm.extract({ text: readable.text, url, tag: "webpage" });
            if (!extracted.is_article) {
              ctx.log.debug({ url }, "webpage: LLM verdict is_article=false, skipped");
              return null;
            }

            return DraftSchema.parse({
              source: "webpage",
              source_item_id: null,
              url,
              title: (extracted.title || readable.title || url).slice(0, 500),
              snippet: extracted.snippet.slice(0, 500),
              author: null,
              published_at: extracted.published_at,
              engagement_score: null,
              engagement: {},
              language: extracted.language,
              extraction_model: ctx.llm.model,
            } satisfies RawItemDraftInput);
          } catch (error) {
            errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }),
      ),
    );

    for (const draft of results) if (draft) items.push(draft);

    if (items.length === 0 && errors.length > 0) return finish([], "error", errors.join("; "));
    if (errors.length > 0) ctx.log.warn({ errors }, "webpage partial failure");
    return finish(items.slice(0, ctx.limit), "ok");
  },
};

/** JS-render fallback; dynamic import so Playwright stays optional. */
async function renderWithPlaywright(
  ctx: { log: { warn: (obj: unknown, msg: string) => void } },
  url: string,
): Promise<{ text: string; title: string } | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const html = await page.content();
      return extractReadable(html, url);
    } finally {
      await browser.close();
    }
  } catch (error) {
    ctx.log.warn({ err: error, url }, "webpage: playwright fallback failed");
    return null;
  }
}
