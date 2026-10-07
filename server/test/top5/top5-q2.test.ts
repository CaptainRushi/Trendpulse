/** Doc 19 Q2: category-only collection, preflight, per-category estimate. */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { loadConfig } from "../../src/config/env.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { LlmClient } from "../../src/llm/client.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import { EventBus } from "../../src/pipeline/events.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { openTestDb } from "../pipeline/helpers.js";
import { insertRun } from "../pipeline/helpers.js";
import { writeSetting } from "../../src/config/settings.js";
import { collectCategory, CATEGORY_MAX_ITEMS } from "../../src/categories/collect.js";
import { estimateRun } from "../../src/categories/estimate.js";
import { QUESTION_SET_VERSION } from "../../src/sorting/questions.js";
import { writeCachedLabels } from "../../src/llm/labelCache.js";
import { HttpClient } from "../../src/collectors/http.js";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";
import { contentHash } from "../../src/utils/hash.js";
import { canonicalizeUrl } from "../../src/utils/url.js";
import { makeCtx, urlOf } from "../collectors/helpers.js";
import { makeRawItem } from "../sorting/helpers.js";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import type { StateDb } from "../../src/db/sqlite.js";

const DAY = "2026-09-30";
const log = pino({ level: "silent" });

function rssFeed(feed: string, n: number, marker: string): string {
  const items = Array.from(
    { length: n },
    (_, i) =>
      `<item><title>Story ${marker} ${String(i)} [${marker}]</title><link>https://${feed}.example.com/${marker}-${String(i)}</link>` +
      `<guid>${feed}-${marker}-${String(i)}</guid><pubDate>Mon, 29 Sep 2026 06:00:00 GMT</pubDate></item>`,
  ).join("");
  return `<rss version="2.0"><channel><title>${feed}</title>${items}</channel></rss>`;
}

interface CallLog {
  url: string;
  ua: string;
}

/** Router with a request log; unmatched → 404, robots.txt → 404 (allow). */
function loggingFetch(routes: { match: string; status?: number; body?: string }[]): {
  fetchImpl: typeof fetch;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, ua: headers.get("user-agent") ?? "" });
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:", { status: 404 });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function categoryFetch(
  opts: { financeStatus?: number; scienceItems?: number } = {},
): { fetchImpl: typeof fetch; calls: CallLog[] } {
  return loggingFetch([
    { match: "feed-ai.xml", body: rssFeed("ai", 3, "AI") },
    { match: "feed-fin.xml", status: opts.financeStatus ?? 200, body: rssFeed("fin", 2, "FIN") },
    { match: "feed-sci.xml", body: rssFeed("sci", opts.scienceItems ?? 2, "SCI") },
  ]);
}

function overrides(): Record<string, unknown> {
  const rss = (feed: string): unknown[] => [
    { collector: "rss", params: { feeds: [`https://x.example.com/${feed}.xml`] }, verified_at: "" },
  ];
  return { ai: rss("feed-ai"), finance: rss("feed-fin"), science: rss("feed-sci") };
}

/** Category by title marker, with a Jev call counter. */
function countingClassifier(counter: { calls: number }): Classifier {
  return {
    modelId: "stub-jev",
    classify: (state: Record<string, string>) => {
      counter.calls += 1;
      const title = state["title"] ?? "";
      const category = title.includes("[AI]") ? "AI" : title.includes("[FIN]") ? "Finance" : "Other";
      return Promise.resolve({
        answers: {
          category: { kind: "choice", choice: category, confidence: 0.9, flags: [] },
          quality: { kind: "noul", noul: 0.9, flags: [] },
          novelty: { kind: "noul", noul: 0.5, flags: [] },
          sentiment: { kind: "choice", choice: "neutral", confidence: 0.8, flags: [] },
        },
        classifier: "jev",
        model: "stub-jev",
      });
    },
  };
}

function writerStub(): LlmClient {
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    const content = user.startsWith("TOPICS:")
      ? { digest: "One. Two. Three." }
      : {
          topics: [...user.matchAll(/<<<CLUSTER (\S+)>>>/g)].map((m) => ({
            cluster_id: m[1],
            title: `Group ${String(m[1])}`,
            summary: "Grouped.",
            why_trending: "Grouped.",
            tags: ["g"],
            content_angles: ["One", "Two", "Three"],
          })),
        };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return new LlmClient({ baseUrl: "http://stub.invalid", apiKey: "", model: "stub-writer", clientName: "extractor", timeoutMs: 5000, fetchImpl });
}

function orch(db: StateDb, sheets: FakeSheetsClient, fetchImpl: typeof fetch, counter: { calls: number }): Orchestrator {
  return new Orchestrator({
    db,
    config: loadConfig({}),
    log,
    events: new EventBus(),
    sheetsClient: sheets,
    sheetsQueue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
    fetchImpl,
    classifier: countingClassifier(counter),
    writerClient: writerStub(),
  });
}

function categoryRows(db: StateDb): { category: string; status: string; items_collected: number; error: string | null }[] {
  return db.prepare("SELECT category, status, items_collected, error FROM category_runs ORDER BY category").all() as {
    category: string;
    status: string;
    items_collected: number;
    error: string | null;
  }[];
}

async function waitForStatus(app: FastifyInstance, runId: string, timeoutMs = 30000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const status = res.json<{ run: { status: string } }>().run.status;
    if (status === "success" || status === "partial" || status === "failed") return status;
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} still pending`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("TOP5-05 only selected categories' sources are called", () => {
  it("ai+finance run never requests science or general sources", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "finance"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl, calls } = categoryFetch();
      const counter = { calls: 0 };
      const summary = await orch(db, sheets, fetchImpl, counter).startRun({ trigger: "manual", runDate: DAY });
      expect(summary.status).toBe("success");
      expect(calls.some((c) => c.url.includes("feed-ai.xml"))).toBe(true);
      expect(calls.some((c) => c.url.includes("feed-fin.xml"))).toBe(true);
      expect(calls.some((c) => c.url.includes("feed-sci.xml"))).toBe(false);
      for (const general of ["hn.algolia.com", "api.github.com", "reddit.com", "firebaseio.com", "google.com"]) {
        expect(calls.some((c) => c.url.includes(general))).toBe(false);
      }
      const targets = db.prepare("SELECT DISTINCT target_category AS t FROM items_run").all() as { t: string | null }[];
      expect(targets.map((r) => r.t).sort()).toEqual(["ai", "finance"]);
      // No Jev or writer work is possible for unselected categories: every
      // collected item carries a selected target.
      expect(counter.calls).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-06 general sources skipped by default, included only with the switch", () => {
  it("no general source stats by default; hackernews attempted with the switch", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai"]);
      const sheets = new FakeSheetsClient();
      const plain = await orch(db, sheets, categoryFetch().fetchImpl, { calls: 0 }).startRun({
        trigger: "manual",
        runDate: DAY,
      });
      expect(["success", "partial"]).toContain(plain.status);
      const plainSources = db
        .prepare("SELECT DISTINCT source AS s FROM run_source_stats WHERE run_id = ?")
        .all(plain.runId) as { s: string }[];
      expect(plainSources.map((r) => r.s)).toEqual(["rss"]);
      writeSetting(db, "include_general_sources", true);
      const general = await orch(db, sheets, categoryFetch().fetchImpl, { calls: 0 }).startRun({
        trigger: "manual",
        runDate: DAY,
      });
      expect(["success", "partial"]).toContain(general.status);
      const generalSources = db
        .prepare("SELECT DISTINCT source AS s FROM run_source_stats WHERE run_id = ?")
        .all(general.runId) as { s: string }[];
      expect(generalSources.map((r) => r.s)).toContain("hackernews");
    } finally {
      db.close();
    }
  });
});

describe("TOP5-07 one failing category does not stop another", () => {
  it("finance 500s: ai completes ok, finance recorded failed, run partial", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "finance"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ financeStatus: 500 });
      const summary = await orch(db, sheets, fetchImpl, { calls: 0 }).startRun({ trigger: "manual", runDate: DAY });
      expect(summary.status).toBe("partial");
      const rows = categoryRows(db);
      expect(rows).toMatchObject([
        { category: "ai", status: "ok" },
        { category: "finance", status: "failed" },
      ]);
      expect(rows[1]?.error).toContain("500");
      expect(rows[0]?.items_collected).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-08 politeness and caps", () => {
  it("per-source cap holds, UA set, robots honored, same-domain gap kept", async () => {
    const big = rssFeed("big", 50, "AI");
    const seen: CallLog[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, ua: headers.get("user-agent") ?? "" });
      if (url.endsWith("/robots.txt")) {
        if (url.includes("blocked.example.com")) {
          return new Response("User-agent: *\nDisallow: /", { status: 200 });
        }
        return new Response("User-agent: *\nDisallow:", { status: 404 });
      }
      if (url.includes("feed-big.xml")) return new Response(big, { status: 200 });
      if (url.includes("feed-blocked.xml")) return new Response(rssFeed("blocked", 3, "AI"), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const ctx = makeCtx({ fetchImpl, limit: CATEGORY_MAX_ITEMS });
    const { items } = await collectCategory(ctx, "ai", [
      { collector: "rss", params: { feeds: ["https://x.example.com/feed-big.xml"] }, verified_at: "" },
    ]);
    expect(items.length).toBeLessThanOrEqual(CATEGORY_MAX_ITEMS);
    expect(items.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.ua === "TrendPulse-Test/1.0")).toBe(true);
    // robots.txt disallows the whole blocked host: nothing collected.
    const blocked = await collectCategory(ctx, "ai", [
      { collector: "rss", params: { feeds: ["https://blocked.example.com/feed-blocked.xml"] }, verified_at: "" },
    ]);
    expect(blocked.items).toEqual([]);
    expect(seen.some((c) => c.url.includes("blocked.example.com/robots.txt"))).toBe(true);
    // Same-domain requests serialize on the limiter gap.
    const timed: number[] = [];
    const timingFetch = (async (): Promise<Response> => {
      timed.push(Date.now());
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const http = new HttpClient({
      userAgent: "TrendPulse-Test/1.0",
      limiter: new DomainRateLimiter({ gapMs: 60 }),
      fetchImpl: timingFetch,
    });
    await http.get("https://paced.example.com/a");
    await http.get("https://paced.example.com/b");
    expect(timed).toHaveLength(2);
    expect((timed[1] ?? 0) - (timed[0] ?? 0)).toBeGreaterThanOrEqual(50);
  });
});

describe("TOP5-09 preflight blockers and warnings", () => {
  it("empty selection blocks; sourceless selection blocks; partial warns and runs", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    try {
      const { fetchImpl } = categoryFetch();
      const counter = { calls: 0 };
      const app = await buildApp({ ...t.ctx, fetchImpl, classifier: countingClassifier(counter), writerClient: writerStub() });
      try {
        const empty = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
        expect(empty.statusCode).toBe(400);
        expect(empty.body).toContain("NO_CATEGORIES_SELECTED");
        await app.inject({ method: "PUT", url: "/api/my-categories", payload: { my_categories: ["other"] } });
        const sourceless = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
        expect(sourceless.statusCode).toBe(400);
        expect(sourceless.body).toContain("CATEGORY_NO_SOURCES");
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: { category_sources: overrides(), my_categories: ["ai", "other"] },
        });
        const started = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
        expect(started.statusCode).toBe(202);
        const runId = started.json<{ run_id: string }>().run_id;
        expect(await waitForStatus(app, runId)).toBe("partial");
        const rows = categoryRows(t.db);
        const other = rows.find((r) => r.category === "other");
        expect(other?.status).toBe("no_sources");
        expect(other?.error ?? "").toContain("CATEGORY_NO_SOURCES");
        expect(rows.find((r) => r.category === "ai")?.status).toBe("ok");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});

describe("TOP5-10 estimate within 30 percent of actual", () => {
  it("ceiling predicts the capped collect and the cache-aware Jev count", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", { ai: [{ collector: "rss", params: { feeds: ["https://x.example.com/feed-big.xml"] }, verified_at: "" }] });
      writeSetting(db, "my_categories", ["ai"]);
      // Stored rows reference their run (items_run.run_id REFERENCES runs(id)).
      insertRun(db, "run-old", DAY);
      // Five stored, already-labeled ai items: seen-dropped from the working
      // set, costing no Jev calls (the steady-state shape).
      const stored = Array.from({ length: 5 }, (_, i) =>
        makeRawItem({
          id: `stored-${String(i)}`,
          run_id: "run-old",
          url: `https://stored.example.com/${String(i)}`,
          title: `Stored story ${String(i)} [AI]`,
          content_hash: `stored-hash-${String(i)}`,
          target_category: "ai",
        }),
      );
      const insert = db.prepare(
        "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, target_category) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      );
      const seen = db.prepare(
        "INSERT INTO seen_items (content_hash, first_seen_date, last_seen_date, source) VALUES (?, ?, ?, ?)",
      );
      for (const item of stored) {
        insert.run(item.id, "run-old", DAY, item.source, item.content_hash, JSON.stringify(item), "ai");
        // Dedupe compares the NORMALIZED hash (sha1 of canonical URL).
        seen.run(contentHash(canonicalizeUrl(item.url), item.title), DAY, DAY, item.source);
        writeCachedLabels(db, {
          itemId: item.id,
          contentHash: item.content_hash,
          questionSetVersion: QUESTION_SET_VERSION,
          model: "stub-jev",
          classifier: "jev",
          answers: {
            category: { answerJson: JSON.stringify({ kind: "choice", choice: "AI", confidence: 0.9 }), confidence: 0.9 },
          },
        });
      }
      const big = rssFeed("big", 60, "AI");
      const { fetchImpl } = loggingFetch([{ match: "feed-big.xml", body: big }]);
      const estimate = estimateRun(
        db,
        {
          categories: ["ai"],
          mode: "strict",
          overrides: { ai: [{ collector: "rss", params: { feeds: ["https://x.example.com/feed-big.xml"] }, verified_at: "" }] },
          redditCreds: false,
          jevModel: "stub-jev",
          questionVersion: QUESTION_SET_VERSION,
        },
        DAY,
        0.04,
      );
      expect(estimate.expected_new_items).toBe(CATEGORY_MAX_ITEMS);
      const perCat = estimate.per_category.find((c) => c.category === "ai");
      expect(perCat?.stored_items_reused).toBe(5);
      expect(perCat?.jev_calls_expected).toBe(CATEGORY_MAX_ITEMS);
      // Cache-awareness the other way: without labels the stored items cost.
      db.prepare("DELETE FROM item_labels").run();
      const unlabeled = estimateRun(
        db,
        {
          categories: ["ai"],
          mode: "strict",
          overrides: { ai: [{ collector: "rss", params: { feeds: ["https://x.example.com/feed-big.xml"] }, verified_at: "" }] },
          redditCreds: false,
          jevModel: "stub-jev",
          questionVersion: QUESTION_SET_VERSION,
        },
        DAY,
        0.04,
      );
      expect(unlabeled.per_category.find((c) => c.category === "ai")?.jev_calls_expected).toBe(
        CATEGORY_MAX_ITEMS + 5,
      );
      const sheets = new FakeSheetsClient();
      const counter = { calls: 0 };
      const summary = await orch(db, sheets, fetchImpl, counter).startRun({ trigger: "manual", runDate: DAY });
      expect(summary.status).toBe("success");
      expect(summary.itemsNew).toBe(CATEGORY_MAX_ITEMS);
      const rel = Math.abs(estimate.expected_new_items - summary.itemsNew) / summary.itemsNew;
      expect(rel).toBeLessThanOrEqual(0.3);
      expect(counter.calls).toBe(estimate.per_category.find((c) => c.category === "ai")?.jev_calls_expected);
      expect(perCat?.writer_clusters_expected).toBe(5);
    } finally {
      db.close();
    }
  });
});
