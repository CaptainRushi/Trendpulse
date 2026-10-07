/** Doc 19 Q3: assign rule, per-category cluster/score/write-top/persist. */
import { describe, expect, it } from "vitest";
import pino from "pino";
import { loadConfig } from "../../src/config/env.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { JevHttpError } from "../../src/llm/jev.js";
import { LlmClient } from "../../src/llm/client.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import { EventBus } from "../../src/pipeline/events.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { openTestDb } from "../pipeline/helpers.js";
import { writeSetting } from "../../src/config/settings.js";
import { assignCategory } from "../../src/sorting/assign.js";
import { writeCachedLabels } from "../../src/llm/labelCache.js";
import { QUESTION_SET_VERSION } from "../../src/sorting/questions.js";
import { urlOf } from "../collectors/helpers.js";
import type { StateDb } from "../../src/db/sqlite.js";

const DAY = "2026-09-30";
const log = pino({ level: "silent" });

const WORDS = ["quantum", "harbor", "ember", "velvet", "cipher", "meadow", "onyx", "prism", "tundra", "zephyr", "basalt", "coral"];

function rssFeed(feed: string, titles: string[]): string {
  const items = titles
    .map(
      (title, i) =>
        `<item><title>${title}</title><link>https://${feed}.example.com/${String(i)}</link>` +
        `<guid>${feed}-${String(i)}</guid><pubDate>Mon, 29 Sep 2026 06:00:00 GMT</pubDate></item>`,
    )
    .join("");
  return `<rss version="2.0"><channel><title>${feed}</title>${items}</channel></rss>`;
}

function aiTitles(n: number): string[] {
  return WORDS.slice(0, n).map((w, i) => `${w} dispatch ${String(i)} [AI]`);
}

function loggingFetch(routes: { match: string; status?: number; body?: string }[]): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:", { status: 404 });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function categoryFetch(opts: { aiCount?: number; financeStatus?: number; scienceEmpty?: boolean } = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  return loggingFetch([
    { match: "feed-ai.xml", body: rssFeed("ai", aiTitles(opts.aiCount ?? 3)) },
    {
      match: "feed-fin.xml",
      status: opts.financeStatus ?? 200,
      body: rssFeed("fin", ["Bank earnings alpha [FIN]", "Bank earnings beta [FIN]"]),
    },
    { match: "feed-sci.xml", body: opts.scienceEmpty === true ? rssFeed("sci", []) : rssFeed("sci", ["Lab result gamma [SCI]"]) },
  ]);
}

function overrides(): Record<string, unknown> {
  const rss = (feed: string): unknown[] => [
    { collector: "rss", params: { feeds: [`https://x.example.com/${feed}.xml`] }, verified_at: "" },
  ];
  return { ai: rss("feed-ai"), finance: rss("feed-fin"), science: rss("feed-sci") };
}

/** Category by title marker, counting Jev invocations (not just uncached). */
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

function writerStub(record?: { clusters: string[]; calls: number }): LlmClient {
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    const ids = [...user.matchAll(/<<<CLUSTER (\S+)>>>/g)].map((m) => m[1] ?? "");
    if (record) {
      record.calls += 1;
      record.clusters.push(...ids);
    }
    const content = user.startsWith("TOPICS:")
      ? { digest: "One. Two. Three." }
      : {
          topics: ids.map((id) => ({
            cluster_id: id,
            title: `Group ${id}`,
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

function orch(
  db: StateDb,
  sheets: FakeSheetsClient,
  fetchImpl: typeof fetch,
  opts: { counter?: { calls: number }; classifier?: Classifier; fallbackClassifier?: Classifier; writer?: LlmClient } = {},
): Orchestrator {
  return new Orchestrator({
    db,
    config: loadConfig({}),
    log,
    events: new EventBus(),
    sheetsClient: sheets,
    sheetsQueue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
    fetchImpl,
    classifier: opts.classifier ?? countingClassifier(opts.counter ?? { calls: 0 }),
    ...(opts.fallbackClassifier ? { fallbackClassifier: opts.fallbackClassifier } : {}),
    writerClient: opts.writer ?? writerStub(),
  });
}

function classifyDetail(db: StateDb, runId: string): { classified: number; cached: number; fallbackUsed: number } {
  const row = db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = 'sort_classify'").get(runId) as {
    detail_json: string;
  };
  const detail = JSON.parse(row.detail_json) as { classified: number; cached: number; fallbackWrites?: number };
  return { classified: detail.classified, cached: detail.cached, fallbackUsed: detail.fallbackWrites ?? 0 };
}

function sheetRows(sheets: FakeSheetsClient, tab: string): string[][] {
  return (sheets.tabs.get(tab) ?? []).slice(1);
}

describe("TOP5-11 assignment rule matrix", () => {
  it("0.59/0.60/0.61 across selected, unselected and missing labels", () => {
    const selected = new Set(["ai", "finance"]);
    // Confident + selected → that category (0.60 is in).
    expect(assignCategory({ label: "AI", confidence: 0.6, selected, target: "ai" })).toEqual({ category: "ai" });
    expect(assignCategory({ label: "Finance", confidence: 0.61, selected, target: "finance" })).toEqual({ category: "finance" });
    // Confident + unselected → excluded even when the target is selected.
    expect(assignCategory({ label: "Tech", confidence: 0.61, selected, target: "ai" })).toEqual({ excluded: "off_category" });
    expect(assignCategory({ label: "Tech", confidence: 0.9, selected, target: null })).toEqual({ excluded: "off_category" });
    // Below 0.6 → the source's category (target), or no assignment.
    expect(assignCategory({ label: "AI", confidence: 0.59, selected, target: "ai" })).toEqual({ category: "ai" });
    expect(assignCategory({ label: "Finance", confidence: 0.59, selected: new Set(["ai"]), target: "ai" })).toEqual({
      category: "ai",
    });
    expect(assignCategory({ label: "AI", confidence: 0.59, selected, target: null })).toEqual({ excluded: "no_assignment" });
    // General runs (empty selection) keep the Jev label.
    expect(assignCategory({ label: "Tech", confidence: 0.9, selected: new Set(), target: null })).toEqual({ category: "tech" });
  });
});

describe("TOP5-12 unselected categories never reach Jev and never get a topic", () => {
  it("stored finance-labeled item is excluded from the working set", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai"]);
      // A finance-labeled, unseen stored item: old code would invoke Jev
      // (cache hit) and topic nothing; new code never sends it at all.
      db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run-old', ?, 'manual', 'success', '[]', ?)").run(
        DAY,
        `${DAY}T06:00:00.000Z`,
      );
      db.prepare(
        "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, target_category) VALUES ('fin-stored', 'run-old', ?, 'rss', 'fin-hash', ?, 1, NULL)",
      ).run(
        DAY,
        JSON.stringify({
          id: "fin-stored",
          run_id: "run-old",
          collected_at: `${DAY}T06:00:00.000Z`,
          source: "rss",
          source_item_id: null,
          url: "https://stored.example.com/fin",
          title: "Bank earnings stored [FIN]",
          snippet: "",
          author: null,
          published_at: null,
          engagement_score: null,
          engagement_extra: {},
          engagement_norm: 0.5,
          language: "en",
          region: null,
          content_hash: "fin-hash",
          merged_sources: [],
          extraction_model: null,
          source_label: null,
          target_category: null,
        }),
      );
      writeCachedLabels(db, {
        itemId: "fin-stored",
        contentHash: "fin-hash",
        questionSetVersion: QUESTION_SET_VERSION,
        model: "stub-jev",
        classifier: "jev",
        answers: {
          category: { answerJson: JSON.stringify({ kind: "choice", choice: "Finance", confidence: 0.9 }), confidence: 0.9 },
        },
      });
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 2 });
      const counter = { calls: 0 };
      const summary = await orch(db, sheets, fetchImpl, { counter }).startRun({ trigger: "manual", runDate: DAY });
      expect(summary.status).toBe("success");
      // Exactly the 2 new ai items invoked Jev — the finance item never did.
      expect(counter.calls).toBe(2);
      const cats = sheetRows(sheets, "sorted_trends").map((row) => row[6]);
      expect(cats.length).toBeGreaterThan(0);
      expect(cats.every((c) => c === "AI")).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-13 writer runs only for the top clusters", () => {
  it("10 clusters in ai → 5 cluster ids reach the writer in one batch", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 10 });
      const record = { clusters: [] as string[], calls: 0 };
      const summary = await orch(db, sheets, fetchImpl, { writer: writerStub(record) }).startRun({
        trigger: "manual",
        runDate: DAY,
      });
      expect(summary.status).toBe("success");
      const clusters = db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = 'sort_cluster'").get(summary.runId) as {
        detail_json: string;
      };
      const total = (JSON.parse(clusters.detail_json) as { clusters: unknown[] }).clusters.length;
      expect(total).toBeGreaterThan(5);
      // Exactly the top 5 reached the writer (batch count is char-capped).
      expect(record.clusters).toHaveLength(5);
      expect(record.calls).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-14 ranks are 1..n within each category", () => {
  it("at most 5 rows per category persisted with in-category ranks", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "finance"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 10 });
      const summary = await orch(db, sheets, fetchImpl, {}).startRun({ trigger: "manual", runDate: DAY });
      expect(summary.status).toBe("success");
      const rows = sheetRows(sheets, "sorted_trends");
      const byCat = new Map<string, { rank: number }[]>();
      for (const row of rows) {
        const list = byCat.get(row[6] ?? "") ?? [];
        list.push({ rank: Number(row[3]) });
        byCat.set(row[6] ?? "", list);
      }
      for (const [cat, list] of byCat) {
        expect(list.length).toBeLessThanOrEqual(5);
        expect(list.map((r) => r.rank).sort((a, b) => a - b)).toEqual(list.map((_, i) => i + 1));
        expect(cat).not.toBe("legacy");
      }
      const index = db.prepare("SELECT category, rank FROM topic_index WHERE run_date = ? AND is_latest = 1").all(DAY) as {
        category: string;
        rank: number;
      }[];
      const aiRanks = index.filter((r) => r.category === "AI").map((r) => r.rank).sort((a, b) => a - b);
      expect(aiRanks.length).toBeLessThanOrEqual(5);
      expect(aiRanks).toEqual(aiRanks.map((_, i) => i + 1));
    } finally {
      db.close();
    }
  });
});

describe("TOP5-15 thin and empty categories", () => {
  it("2-cluster ai and itemless science persist without crashing", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "science"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 2, scienceEmpty: true });
      const summary = await orch(db, sheets, fetchImpl, {}).startRun({ trigger: "manual", runDate: DAY });
      expect(["success", "partial"]).toContain(summary.status);
      const rows = sheetRows(sheets, "sorted_trends");
      expect(rows.filter((row) => row[6] === "AI").length).toBe(2);
      expect(rows.filter((row) => row[6] === "Science")).toHaveLength(0);
      const stats = db.prepare("SELECT category, status, items_collected FROM category_runs WHERE run_id = ?").all(summary.runId) as {
        category: string;
        status: string;
        items_collected: number;
      }[];
      expect(stats.find((r) => r.category === "science")).toMatchObject({ status: "ok", items_collected: 0 });
    } finally {
      db.close();
    }
  });
});

describe("TOP5-16 subset refresh replaces only its categories", () => {
  it("finance refresh leaves the ai set and the digest alone", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "finance"]);
      const sheets = new FakeSheetsClient();
      const first = await orch(db, sheets, categoryFetch({ aiCount: 3 }).fetchImpl, {}).startRun({
        trigger: "manual",
        runDate: DAY,
      });
      expect(first.status).toBe("success");
      const aiBefore = sheetRows(sheets, "sorted_trends").filter((row) => row[6] === "AI");
      expect(aiBefore.length).toBeGreaterThan(0);
      const second = await orch(db, sheets, categoryFetch({ aiCount: 3 }).fetchImpl, {}).startRun({
        trigger: "manual",
        runDate: DAY,
        categories: ["finance"],
      });
      expect(["success", "partial"]).toContain(second.status);
      const rows = sheetRows(sheets, "sorted_trends");
      // ai rows untouched: same run, still latest.
      expect(rows.filter((row) => row[6] === "AI" && row[1] === first.runId && row[23] === "TRUE")).toHaveLength(aiBefore.length);
      // finance rows replaced by the refresh run.
      expect(rows.filter((row) => row[6] === "Finance" && row[1] === second.runId && row[23] === "TRUE").length).toBeGreaterThan(0);
      expect(rows.filter((row) => row[6] === "Finance" && row[1] === first.runId && row[23] === "TRUE")).toHaveLength(0);
      const digests = sheetRows(sheets, "daily_digest");
      expect(digests).toHaveLength(1);
      expect(digests[0]?.[1]).toBe(first.runId);
      const secondCats = db.prepare("SELECT category FROM category_runs WHERE run_id = ?").all(second.runId) as { category: string }[];
      expect(secondCats.map((r) => r.category)).toEqual(["finance"]);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-17 full run writes one digest", () => {
  it("exactly one digest row per date after a full run", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai", "finance"]);
      const sheets = new FakeSheetsClient();
      const summary = await orch(db, sheets, categoryFetch({ aiCount: 3 }).fetchImpl, {}).startRun({
        trigger: "manual",
        runDate: DAY,
      });
      expect(summary.status).toBe("success");
      expect(sheetRows(sheets, "daily_digest")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-18 same-day rerun adds ~0 raw rows and uses cached labels", () => {
  it("rerun persists no new item rows and classifies from cache", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 3 });
      const counter = { calls: 0 };
      const o = orch(db, sheets, fetchImpl, { counter });
      const first = await o.startRun({ trigger: "manual", runDate: DAY });
      expect(first.status).toBe("success");
      const callsAfterFirst = counter.calls;
      expect(callsAfterFirst).toBeGreaterThan(0);
      const second = await o.startRun({ trigger: "manual", runDate: DAY });
      expect(["success", "partial"]).toContain(second.status);
      const newRows = db.prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_id = ?").get(second.runId) as { n: number };
      expect(newRows.n).toBe(0);
      const detail = classifyDetail(db, second.runId);
      expect(detail.classified).toBe(0);
      expect(detail.cached).toBeGreaterThan(0);
      expect(counter.calls).toBe(callsAfterFirst);
    } finally {
      db.close();
    }
  });
});

describe("TOP5-19 Jev down and writer failing do not crash the run", () => {
  it("fallback labels plus fallback text still produce topics", async () => {
    const db = openTestDb();
    try {
      writeSetting(db, "category_sources", overrides());
      writeSetting(db, "my_categories", ["ai"]);
      const sheets = new FakeSheetsClient();
      const { fetchImpl } = categoryFetch({ aiCount: 3 });
      const downClassifier: Classifier = {
        modelId: "stub-jev",
        classify: () => Promise.reject(new JevHttpError("Jev is down", { status: 500 })),
      };
      const fallback: Classifier = {
        modelId: "stub-fallback",
        classify: (_state: Record<string, string>) =>
          Promise.resolve({
            answers: {
              category: { kind: "choice", choice: "AI", confidence: 0.5, flags: [] },
              quality: { kind: "noul", noul: 0.9, flags: [] },
              novelty: { kind: "noul", noul: 0.5, flags: [] },
              sentiment: { kind: "choice", choice: "neutral", confidence: 0.8, flags: [] },
            },
            classifier: "fallback",
            model: "stub-fallback",
          }),
      };
      const deadWriter = new LlmClient({
        baseUrl: "http://stub.invalid",
        apiKey: "",
        model: "stub-writer",
        clientName: "extractor",
        timeoutMs: 5000,
        fetchImpl: () => Promise.reject(new Error("writer is down")),
      });
      const summary = await orch(db, sheets, fetchImpl, {
        classifier: downClassifier,
        fallbackClassifier: fallback,
        writer: deadWriter,
      }).startRun({ trigger: "manual", runDate: DAY });
      expect(["success", "partial"]).toContain(summary.status);
      const detail = classifyDetail(db, summary.runId);
      expect(detail.fallbackUsed).toBeGreaterThan(0);
      const rows = sheetRows(sheets, "sorted_trends").filter((row) => row[6] === "AI");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(5);
    } finally {
      db.close();
    }
  });
});
