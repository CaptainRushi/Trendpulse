import { describe, expect, it } from "vitest";
import pino from "pino";
import { loadConfig } from "../../src/config/env.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { LlmClient } from "../../src/llm/client.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import { EventBus } from "../../src/pipeline/events.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { RawTrendRecord } from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { openTestDb } from "../pipeline/helpers.js";
import { writeSetting } from "../../src/config/settings.js";
import { resolveCronCategories } from "../../src/scheduler/cron.js";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import type { StateDb } from "../../src/db/sqlite.js";

const DAY = "2026-09-30";
const log = pino({ level: "silent" });

function fastQueue(): SheetsWriteQueue {
  return new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
}

function rssFeed(items: { title: string; link: string }[]): string {
  return (
    `<rss version="2.0"><channel><title>t</title>` +
    items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.link}</guid><pubDate>Mon, 29 Sep 2026 06:00:00 GMT</pubDate></item>`).join("") +
    `</channel></rss>`
  );
}

/** Category by title marker: [AI] → AI 0.9, [FIN] → Finance 0.9, else Other. */
function titleClassifier(): Classifier {
  return {
    modelId: "stub-jev",
    classify: (state: Record<string, string>) => {
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
      ? { digest: "One. Two." }
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

function aiFeed(): string {
  return rssFeed([
    { title: "AI breakthrough [AI]", link: "https://x.example.com/ai1" },
    { title: "AI funding round [AI]", link: "https://x.example.com/ai2" },
    { title: "Bank earnings [FIN]", link: "https://x.example.com/fin1" },
  ]);
}

function categoryFetch(): { fetchImpl: typeof fetch } {
  const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("feed-ai.xml")) return Promise.resolve(new Response(aiFeed(), { status: 200 }));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

function aiOverrides(): Record<string, unknown> {
  return { ai: [{ collector: "rss", params: { feeds: ["https://x.example.com/feed-ai.xml"] }, verified_at: "" }] };
}

function orch(db: StateDb, sheets: FakeSheetsClient, fetchImpl: typeof fetch): Orchestrator {
  return new Orchestrator({
    db,
    config: loadConfig({}),
    log,
    events: new EventBus(),
    sheetsClient: sheets,
    sheetsQueue: fastQueue(),
    fetchImpl,
    classifier: titleClassifier(),
    writerClient: writerStub(),
  });
}

function classifyDetail(db: StateDb, runId: string): { classified: number; cached: number } {
  const row = db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = 'sort_classify'").get(runId) as {
    detail_json: string;
  };
  const detail = JSON.parse(row.detail_json) as { classified: number; cached: number };
  return { classified: detail.classified, cached: detail.cached };
}

describe("CATRUN-08 strict versus loose", () => {
  it("strict excludes off-scope labels; loose keeps everything", async () => {
    for (const mode of ["strict", "loose"] as const) {
      const db = openTestDb();
      try {
        writeSetting(db, "category_sources", aiOverrides());
        const sheets = new FakeSheetsClient();
        const { fetchImpl } = categoryFetch();
        const o = orch(db, sheets, fetchImpl);
        const summary = await o.startRun({ trigger: "manual", runDate: DAY, categories: ["ai"], mode });
        expect(summary.status).toBe("success");
        const rows = db.prepare("SELECT payload_json FROM items_run").all() as { payload_json: string }[];
        expect(rows.length).toBeGreaterThan(0);
        const topics = db.prepare("SELECT topic_id FROM topic_index").all() as { topic_id: string }[];
        expect(topics.length).toBeGreaterThan(0);
        const focus = db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = 'sort_focus'").get(summary.runId) as {
          detail_json: string;
        };
        const excluded = (JSON.parse(focus.detail_json) as { excluded: { itemId: string }[] }).excluded;
        if (mode === "strict") {
          expect(excluded.length).toBe(1);
        } else {
          expect(excluded).toEqual([]);
        }
      } finally {
        db.close();
      }
    }
  });
});

describe("CATRUN-07 stored items reused with zero new Jev calls", () => {
  it("resort classifies from cache; only the uncached item costs", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", aiOverrides());
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch();
      const o = orch(db, sheets, fetchImpl);
      const first = await o.startRun({ trigger: "manual", runDate: DAY, categories: ["ai"], mode: "loose" });
      expect(classifyDetail(db, first.runId)).toMatchObject({ classified: 3, cached: 0 });
      // One genuinely new item appears; the rest is cache.
      const fresh = RawTrendRecord.parse({
        id: "brand-new",
        run_id: first.runId,
        collected_at: "2026-09-30T07:00:00.000Z",
        source: "rss",
        source_item_id: null,
        url: "https://x.example.com/new",
        title: "Fresh AI story [AI]",
        snippet: "",
        author: null,
        published_at: null,
        engagement_score: 1,
        engagement_extra: {},
        engagement_norm: 0.1,
        language: null,
        region: null,
        content_hash: "brand-new-hash",
        merged_sources: [],
        extraction_model: null,
        source_label: null,
        target_category: "ai",
      });
      db.prepare(
        "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status) VALUES ('brand-new', ?, ?, 'rss', 'brand-new-hash', ?, 1, 'pending')",
      ).run(first.runId, DAY, JSON.stringify(fresh));
      const o2 = orch(db, sheets, fetchImpl);
      const second = await o2.startRun({
        trigger: "manual",
        runDate: DAY,
        categories: ["ai"],
        stages: ["sort_classify", "sort_focus", "sort_cluster", "sort_write", "score", "persist_sorted"],
      });
      expect(second.status).toBe("success");
      expect(classifyDetail(db, second.runId)).toMatchObject({ classified: 1, cached: 3 });
    } finally {
      db.close();
    }
  });
});

describe("CATRUN-14 same-scope rerun adds about zero raw rows", () => {
  it("second identical run persists nothing new and keeps the set latest", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", aiOverrides());
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch();
      const first = await orch(db, sheets, fetchImpl).startRun({ trigger: "manual", runDate: DAY, categories: ["ai"] });
      const count1 = (db.prepare("SELECT COUNT(*) AS n FROM items_run").get() as { n: number }).n;
      expect(count1).toBeGreaterThan(0);
      const second = await orch(db, sheets, fetchImpl).startRun({ trigger: "manual", runDate: DAY, categories: ["ai"] });
      const count2 = (db.prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_id = ?").get(second.runId) as { n: number }).n;
      expect(count2).toBe(0);
      expect(second.status).toBe("success");
      const latest = db.prepare("SELECT topic_id FROM topic_index WHERE run_date = ? AND is_latest = 1").all(DAY) as {
        topic_id: string;
      }[];
      expect(latest.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("CATRUN-13 cron default_categories and CATEGORY_NO_SOURCES", () => {
  it("resolveCronCategories reads the settings key", () => {
    const db = openTestDb();
    try {
      expect(resolveCronCategories(db)).toEqual([]);
      writeSetting(db, "default_categories", ["ai", "finance"]);
      expect(resolveCronCategories(db)).toEqual(["ai", "finance"]);
    } finally {
      db.close();
    }
  });

  it("POST /api/runs rejects unknown categories and sourceless scopes", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const bogus = await app.inject({ method: "POST", url: "/api/runs", payload: { categories: ["bogus"] } });
      expect(bogus.statusCode).toBe(400);
      const redditOnly = await app.inject({ method: "POST", url: "/api/runs", payload: { categories: ["other"] } });
      // `other` has no sources at all → same blocker family.
      expect(redditOnly.statusCode).toBe(400);
      expect(redditOnly.body).toContain("CATEGORY_NO_SOURCES");
    } finally {
      await app.close();
      await t.close();
    }
  });
});
