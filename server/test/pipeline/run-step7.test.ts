/**
 * Step-7 orchestrator contract (docs/12 Prompt 7). Titles start with the test
 * ID per CLAUDE.md rule 9. Additive — descriptive Phase-6 suites stay.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { StateDb } from "../../src/db/sqlite.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { LlmClient } from "../../src/llm/client.js";
import { STAGES } from "../../src/pipeline/orchestrator.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import { EventBus } from "../../src/pipeline/events.js";
import type { PipelineEvent } from "../../src/pipeline/events.js";
import { acquirePipelineLock, LockBusyError, releasePipelineLock } from "../../src/scheduler/lock.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { FakeJevServer } from "../fakes/fakeJevServer.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { insertRun, openTestDb } from "./helpers.js";

const DAY = "2026-09-30";
const config = loadConfig({});
const log = pino({ level: "silent" });

function fastQueue(): SheetsWriteQueue {
  return new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
}

function hnFetch(): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/topstories.json")) return Promise.resolve(new Response("[11,22]", { status: 200 }));
    const match = /\/item\/(\d+)\.json/.exec(url);
    const id = match?.[1] ?? "0";
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: Number(id), type: "story", title: `HN story ${id}`, url: `https://hn.example.com/${id}`, score: Number(id), descendants: 2, time: 1759200000, by: "t" }),
        { status: 200 },
      ),
    );
  });
}

function sorterStubs(): { classifier: Classifier; writerClient: LlmClient } {
  const classifier: Classifier = {
    modelId: "stub-jev",
    classify: () =>
      Promise.resolve({
        answers: {
          category: { kind: "choice", choice: "Tech", confidence: 0.9, flags: [] },
          quality: { kind: "noul", noul: 0.9, flags: [] },
          novelty: { kind: "noul", noul: 0.5, flags: [] },
          sentiment: { kind: "choice", choice: "neutral", confidence: 0.8, flags: [] },
        },
        classifier: "jev",
        model: "stub-jev",
      }),
  };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    const content =
      user.startsWith("TOPICS:")
        ? { digest: "One. Two. Three." }
        : {
            topics: [...user.matchAll(/<<<CLUSTER (\S+)>>>/g)].map((m) => ({
              cluster_id: m[1],
              title: `Group ${String(m[1])}`,
              summary: "A group of stories.",
              why_trending: "Grouped.",
              tags: ["g"],
              content_angles: ["One", "Two", "Three"],
            })),
          };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const writerClient = new LlmClient({
    baseUrl: "http://stub.invalid",
    apiKey: "",
    model: "stub-writer",
    clientName: "extractor",
    timeoutMs: 5000,
    fetchImpl,
  });
  return { classifier, writerClient };
}

function stageStatuses(db: StateDb, runId: string): Record<string, string> {
  const rows = db.prepare("SELECT stage, status FROM run_stages WHERE run_id = ?").all(runId) as {
    stage: string;
    status: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.stage, row.status]));
}

describe("STEP 7 orchestrator", () => {
  it("RUN-01 stages run in order with checkpoints", async () => {
    const db = openTestDb();
    try {
      const orch = new Orchestrator({
        db, config, log, sheetsClient: new FakeSheetsClient(), sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
      expect([...STAGES]).toEqual([
        "collect", "normalize", "dedupe", "persist_raw", "sort_classify",
        "sort_cluster", "sort_write", "score", "persist_sorted", "finalize",
      ]);
      const rows = db
        .prepare("SELECT stage FROM run_stages WHERE run_id = ? ORDER BY rowid")
        .all(summary.runId) as { stage: string }[];
      expect(rows.map((r) => r.stage)).toEqual([...STAGES]);
      const statuses = stageStatuses(db, summary.runId);
      for (const stage of STAGES) expect(statuses[stage]).toBe("done");
    } finally {
      db.close();
    }
  });

  it("RUN-02 success path records stages, rows and counts", async () => {
    const db = openTestDb();
    try {
      const sheets = new FakeSheetsClient();
      const orch = new Orchestrator({
        db, config, log, sheetsClient: sheets, sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
      expect(summary.itemsCollected).toBe(2);
      expect(summary.itemsNew).toBe(2);
      expect(summary.topicsCount).toBeGreaterThan(0);
      expect(sheets.rowCount("raw_trends")).toBe(3);
      expect(sheets.rowCount("runs_log")).toBe(2);
    } finally {
      db.close();
    }
  });

  it("RUN-03 one failing collector makes the run partial", async () => {
    const db = openTestDb();
    try {
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: new FakeSheetsClient(),
        sheetsQueue: fastQueue(),
        fetchImpl: (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("reddit.com")) return Promise.resolve(new Response("down", { status: 500 }));
          return hnFetch()(input);
        },
        ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews", "reddit"] });
      expect(summary.status).toBe("partial");
      const stats = db.prepare("SELECT status FROM run_source_stats WHERE run_id = ?").all(summary.runId) as {
        status: string;
      }[];
      expect(stats.map((s) => s.status).sort()).toEqual(["error", "ok"]);
    } finally {
      db.close();
    }
  });

  it("RUN-04 all collectors failing fails the run at normalize", async () => {
    const db = openTestDb();
    try {
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: new FakeSheetsClient(),
        sheetsQueue: fastQueue(),
        fetchImpl: () => Promise.resolve(new Response("down", { status: 503 })),
        ...sorterStubs(),
      });
      await expect(
        orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] }),
      ).rejects.toThrow(/no items collected/);
      const row = db.prepare("SELECT id, status FROM runs ORDER BY started_at DESC LIMIT 1").get() as {
        id: string;
        status: string;
      };
      expect(row.status).toBe("failed");
      expect(stageStatuses(db, row.id)["normalize"]).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("RUN-04 Sheets 403 fails the run at persist_raw", async () => {
    const db = openTestDb();
    try {
      const sheets = new FakeSheetsClient();
      sheets.failNext({ method: "appendRows", times: 99, status: 403, errorCode: "FORBIDDEN" });
      const orch = new Orchestrator({
        db, config, log, sheetsClient: sheets, sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      await expect(
        orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] }),
      ).rejects.toThrow(/403|FORBIDDEN|denied/i);
      const row = db.prepare("SELECT id, status FROM runs ORDER BY started_at DESC LIMIT 1").get() as {
        id: string;
        status: string;
      };
      expect(row.status).toBe("failed");
      expect(stageStatuses(db, row.id)["persist_raw"]).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("RUN-07 second trigger while locked throws LockBusyError", async () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-holder", DAY);
      acquirePipelineLock(db, "run-holder");
      try {
        const orch = new Orchestrator({
          db, config, log, sheetsClient: new FakeSheetsClient(), sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
        });
        await expect(orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] })).rejects.toBeInstanceOf(
          LockBusyError,
        );
      } finally {
        releasePipelineLock(db, "run-holder");
      }
    } finally {
      db.close();
    }
  });

  it("RUN-08 stale locks recover so new runs start", async () => {
    const db = openTestDb();
    try {
      db.prepare("INSERT INTO locks (name, run_id, heartbeat_at) VALUES ('pipeline', 'run-old', '2000-01-01T00:00:00.000Z')").run();
      const orch = new Orchestrator({
        db, config, log, sheetsClient: new FakeSheetsClient(), sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
    } finally {
      db.close();
    }
  });

  it("RUN-12 events stream in order with replay for late subscribers", async () => {
    const db = openTestDb();
    try {
      const events = new EventBus();
      const live: PipelineEvent[] = [];
      events.subscribe((event) => {
        live.push(event);
      });
      const orch = new Orchestrator({
        db, config, log, events, sheetsClient: new FakeSheetsClient(), sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      const types = live.map((e) => e.type);
      expect(types[0]).toBe("stage");
      expect(types).toContain("source");
      expect(types).toContain("progress");
      expect(types).toContain("done");
      // Finalize's own done event precedes its stage-done marker.
      expect(types.slice(-2)).toEqual(["done", "stage"]);
      // Pulse index events ride the shared bus under runId "pulse" (Doc 16).
      expect(live.filter((e) => e.runId !== "pulse").every((e) => e.runId === summary.runId)).toBe(true);
      const replay = events.history(50);
      expect(replay.length).toBeLessThanOrEqual(50);
      expect(replay.map((e) => e.seq)).toEqual(live.slice(-50).map((e) => e.seq));
    } finally {
      db.close();
    }
  });

  it("RUN-14 runs_log carries llm token totals", async () => {
    const db = openTestDb();
    const server = await FakeJevServer.start("ok");
    try {
      const sheets = new FakeSheetsClient();
      const stubs = sorterStubs();
      const orch = new Orchestrator({
        db,
        config: loadConfig({ JEV_BASE_URL: server.url, JEV_API_KEY: "", JEV_MODEL: "jev-test" }),
        log,
        sheetsClient: sheets,
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        writerClient: stubs.writerClient,
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
      const repo = new SheetsRepo(sheets, { spreadsheetId: "s", cacheTtlS: 60, queue: fastQueue() });
      const runs = await repo.readRunLog();
      const entry = runs.rows.find((r) => r.run_id === summary.runId);
      expect(entry).toBeDefined();
      expect(entry?.llm_calls).toBeGreaterThan(0);
      const totals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in), 0) AS tin FROM llm_calls WHERE run_id = ?").get(
        summary.runId,
      ) as { n: number; tin: number };
      expect(entry?.llm_calls).toBe(totals.n);
      expect(entry?.tokens_in).toBe(totals.tin);
      expect(totals.tin).toBeGreaterThan(0);
    } finally {
      await server.stop();
      db.close();
    }
  });

  it("W-07 fake pipeline reconciles raw, sorted, digest and runs_log", async () => {
    const db = openTestDb();
    try {
      const sheets = new FakeSheetsClient();
      const orch = new Orchestrator({
        db, config, log, sheetsClient: sheets, sheetsQueue: fastQueue(), fetchImpl: hnFetch(), ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.itemsCollected).toBe(2);
      // raw rows == persisted items (+ header).
      expect(sheets.rowCount("raw_trends")).toBe(summary.itemsCollected + 1);
      // sorted rows == API-ready topics.
      const repo = new SheetsRepo(sheets, { spreadsheetId: "s", cacheTtlS: 60, queue: fastQueue() });
      const sorted = await repo.readSorted({ runDate: DAY, onlyLatest: true });
      expect(sorted.rows.length).toBe(summary.topicsCount);
      expect(sorted.rows.length).toBeGreaterThan(0);
      // digest + runs_log rows exist.
      expect(sheets.rowCount("daily_digest")).toBe(2);
      expect(sheets.rowCount("runs_log")).toBe(2);
    } finally {
      db.close();
    }
  });
});
