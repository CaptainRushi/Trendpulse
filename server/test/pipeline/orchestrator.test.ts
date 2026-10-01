/** End-to-end orchestrator tests: full runs, kill-resume, 409, retry, re-sort. */
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { StateDb } from "../../src/db/sqlite.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import {
  acquirePipelineLock,
  LockBusyError,
  recoverOnBoot,
  releasePipelineLock,
} from "../../src/scheduler/lock.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import type { SortedTrendRecord } from "../../src/sheets/schema.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { insertRun, openTestDb } from "./helpers.js";
import { StubJevClient } from "../sorting/helpers.js";

const DAY = "2026-09-30";
const config = loadConfig({});
const log = pino({ level: "silent" });

function fastQueue(): SheetsWriteQueue {
  return new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
}

/** HackerNews-shaped stub: 3 top stories with full item bodies. */
function hnFetch(): typeof fetch {
  return ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/topstories.json")) {
      return Promise.resolve(new Response("[11,22,33]", { status: 200 }));
    }
    const match = /\/item\/(\d+)\.json/.exec(url);
    const id = match?.[1] ?? "0";
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: Number(id),
          type: "story",
          title: `HN story ${id}`,
          url: `https://hn.example.com/${id}`,
          score: Number(id),
          descendants: 4,
          time: 1759200000,
          by: "tester",
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
}

interface JevHandlers {
  onMap?: (callNo: number, user: string) => unknown;
}

/** Deterministic Jev: map chunks ids in tens, reduce merges all, digest fixed. */
function jevStub(handlers: JevHandlers = {}): StubJevClient {
  let mapCalls = 0;
  return new StubJevClient((tag, user) => {
    if (tag === "jev_digest") return { digest: "One. Two. Three." };
    if (tag === "jev_reduce") {
      const ids: string[] = [];
      for (const line of user.split("\n")) {
        const match = /items: (\S+)/.exec(line);
        if (match?.[1]) ids.push(...match[1].split(","));
      }
      return {
        topics: [
          {
            title: "Everything today",
            summary: "All stories merged.",
            category: "Tech",
            tags: ["day"],
            relevance: 70,
            novelty: 60,
            momentum: "rising",
            sentiment: "neutral",
            why_trending: "Coverage.",
            content_angles: ["Recap", "Details", "Outlook"],
            item_ids: ids,
          },
        ],
      };
    }
    mapCalls += 1;
    if (handlers.onMap) return handlers.onMap(mapCalls, user);
    const ids: string[] = [];
    for (const line of user.split("\n")) {
      const match = /^\[(.+?)\]/.exec(line);
      if (match?.[1]) ids.push(match[1]);
    }
    const topics = [];
    for (let i = 0; i < ids.length; i += 10) {
      const group = ids.slice(i, i + 10);
      topics.push({
        title: `Batch group ${String(i / 10)}`,
        summary: "A group of stories.",
        category: "Tech",
        tags: ["g"],
        relevance: 60,
        novelty: 50,
        momentum: "rising",
        sentiment: "neutral",
        why_trending: "Grouped.",
        content_angles: ["One", "Two", "Three"],
        item_ids: group,
      });
    }
    return { topics };
  });
}

function stageStatuses(db: StateDb, runId: string): Record<string, string> {
  const rows = db.prepare("SELECT stage, status FROM run_stages WHERE run_id = ?").all(runId) as {
    stage: string;
    status: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.stage, row.status]));
}

function idToUrl(db: StateDb, runId: string): Map<string, string> {
  const rows = db.prepare("SELECT payload_json FROM items_run WHERE run_id = ?").all(runId) as {
    payload_json: string;
  }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { id: string; url: string };
    map.set(payload.id, payload.url);
  }
  return map;
}

function stableTopics(topics: SortedTrendRecord[], urls: Map<string, string>): object[] {
  return topics.map((t) => ({
    rank: t.rank,
    title: t.title,
    trend_score: t.trend_score,
    evidence: t.evidence_item_ids.map((id) => urls.get(id) ?? id).sort(),
  }));
}

function scoreDetail(db: StateDb, runId: string): SortedTrendRecord[] {
  const row = db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = 'score'").get(runId) as {
    detail_json: string;
  };
  return (JSON.parse(row.detail_json) as { topics: SortedTrendRecord[] }).topics;
}

describe("orchestrator full run", () => {
  it("runs all ten stages to success with observable artifacts", async () => {
    const db = openTestDb();
    try {
      const client = new FakeSheetsClient();
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: client,
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: jevStub(),
      });
      const summary = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
      expect(summary.itemsCollected).toBe(3);
      expect(summary.itemsNew).toBe(3);
      expect(summary.topicsCount).toBe(1);

      const statuses = stageStatuses(db, summary.runId);
      for (const stage of [
        "collect",
        "normalize",
        "dedupe",
        "engagement_norm",
        "persist_raw",
        "sort_map",
        "sort_reduce",
        "score",
        "persist_sorted",
        "finalize",
      ]) {
        expect(statuses[stage]).toBe("done");
      }
      // Sheet artifacts: 3 raw + header, 1 sorted + header, digest + runs_log.
      expect(client.rowCount("raw_trends")).toBe(4);
      expect(client.rowCount("sorted_trends")).toBe(2);
      expect(client.rowCount("daily_digest")).toBe(2);
      expect(client.rowCount("runs_log")).toBe(2);
      // items_run fully persisted; lock released.
      const pending = db.prepare("SELECT COUNT(*) AS n FROM items_run WHERE persisted = 0").get() as { n: number };
      expect(pending.n).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM locks WHERE name = 'pipeline'").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("second trigger while running gets LockBusyError (the 409)", async () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-holder", DAY);
      acquirePipelineLock(db, "run-holder");
      try {
        const orch = new Orchestrator({
          db,
          config,
          log,
          sheetsClient: new FakeSheetsClient(),
          sheetsQueue: fastQueue(),
          fetchImpl: hnFetch(),
          jevClient: jevStub(),
        });
        await expect(
          orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] }),
        ).rejects.toBeInstanceOf(LockBusyError);
      } finally {
        releasePipelineLock(db, "run-holder");
      }
    } finally {
      db.close();
    }
  });
});

describe("kill mid-sort_map and resume", () => {
  it("resumes from sort_map with no duplicate raw rows and identical topics", async () => {
    const db = openTestDb();
    const seedBatchSize = (): void => {
      db.prepare("INSERT INTO settings (key, value_json) VALUES ('sort_batch_size', '2')").run();
    };
    try {
      seedBatchSize();
      const client = new FakeSheetsClient();
      const dyingJev = jevStub({
        onMap: () => {
          throw new Error("SIGKILL simulated");
        },
      });
      const dying = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: client,
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: dyingJev,
      });
      // 3 items / batchSize 2 → map dies on the first batch call (unexpected
      // error propagates: stage and run stay `running`, lock is released).
      await expect(
        dying.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] }),
      ).rejects.toThrow("SIGKILL simulated");

      const doomed = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[];
      expect(doomed).toHaveLength(1);
      const runId = doomed[0]?.id ?? "";
      expect(stageStatuses(db, runId)["sort_map"]).toBe("running");
      expect(stageStatuses(db, runId)["persist_raw"]).toBe("done");

      // Restart: boot recovery marks the dead run interrupted (as index.ts does).
      const recovered = recoverOnBoot(db);
      expect(recovered.interruptedRuns).toEqual([runId]);

      // Restart with a healthy client: resume from the first non-done stage.
      const healthy = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: client,
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: jevStub(),
      });
      const resumed = await healthy.retryRun(runId);
      expect(resumed.status).toBe("success");
      expect(client.rowCount("raw_trends")).toBe(4); // header + 3, no duplicates

      // Same topics as an uninterrupted clean run over the same items
      // (same batch size, so the reduce step applies to both).
      const cleanDb = openTestDb();
      try {
        cleanDb.prepare("INSERT INTO settings (key, value_json) VALUES ('sort_batch_size', '2')").run();
        const cleanClient = new FakeSheetsClient();
        const clean = new Orchestrator({
          db: cleanDb,
          config,
          log,
          sheetsClient: cleanClient,
          sheetsQueue: fastQueue(),
          fetchImpl: hnFetch(),
          jevClient: jevStub(),
        });
        const cleanSummary = await clean.startRun({
          trigger: "manual",
          runDate: DAY,
          sources: ["hackernews"],
        });
        expect(cleanSummary.status).toBe("success");
        // Same stories grouped identically (ids differ across runs by design).
        expect(stableTopics(scoreDetail(db, runId), idToUrl(db, runId))).toEqual(
          stableTopics(scoreDetail(cleanDb, cleanSummary.runId), idToUrl(cleanDb, cleanSummary.runId)),
        );
      } finally {
        cleanDb.close();
      }
    } finally {
      db.close();
    }
  });
});

describe("retry from a failed stage", () => {
  it("reuses done stages (collect runs once) and completes", async () => {
    const db = openTestDb();
    try {
      const client = new FakeSheetsClient();
      client.failNext({ method: "appendRows", times: 1, status: 403 });
      let fetches = 0;
      const countingFetch = ((input: RequestInfo | URL): Promise<Response> => {
        fetches += 1;
        return hnFetch()(input);
      }) as typeof fetch;
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: client,
        sheetsQueue: fastQueue(),
        fetchImpl: countingFetch,
        jevClient: jevStub(),
      });
      await expect(
        orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] }),
      ).rejects.toThrow();
      const failed = db.prepare("SELECT id FROM runs WHERE status = 'failed'").all() as { id: string }[];
      expect(failed).toHaveLength(1);
      const runId = failed[0]?.id ?? "";
      expect(stageStatuses(db, runId)["persist_raw"]).toBe("failed");
      expect(stageStatuses(db, runId)["collect"]).toBe("done");

      const fetchesBeforeRetry = fetches;
      const resumed = await orch.retryRun(runId);
      expect(resumed.status).toBe("success");
      expect(fetches).toBe(fetchesBeforeRetry); // collect not re-run
      expect(client.rowCount("raw_trends")).toBe(4);
    } finally {
      db.close();
    }
  });

  it("refuses to rewind at/before persist_raw once rows are persisted", async () => {
    const db = openTestDb();
    try {
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: new FakeSheetsClient(),
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: jevStub(),
      });
      const summary = await orch.startRun({
        trigger: "manual",
        runDate: DAY,
        sources: ["hackernews"],
        stages: ["collect", "normalize", "dedupe", "engagement_norm", "persist_raw"],
      });
      expect(summary.status).toBe("success");
      db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(summary.runId);
      await expect(orch.retryRun(summary.runId, "normalize")).rejects.toThrow(/already persisted/);
    } finally {
      db.close();
    }
  });
});

describe("resortRun", () => {
  it("re-sorts the date's items into a new latest set and flips the old one", async () => {
    const db = openTestDb();
    try {
      const client = new FakeSheetsClient();
      const base = {
        db,
        config,
        log,
        sheetsClient: client,
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: jevStub(),
      };
      const orch = new Orchestrator(base);
      const first = await orch.startRun({ trigger: "manual", runDate: DAY, sources: ["hackernews"] });
      expect(first.status).toBe("success");

      const resorted = await orch.resortRun(DAY);
      expect(resorted.status).toBe("success");
      expect(resorted.topicsCount).toBe(first.topicsCount);
      // Re-sort reuses the date's item rows (same ULIDs) — one url map serves both.
      const urls = idToUrl(db, first.runId);
      expect(stableTopics(scoreDetail(db, resorted.runId), urls)).toEqual(
        stableTopics(scoreDetail(db, first.runId), urls),
      );
      // Two sets in the sheet; exactly the new set is latest.
      expect(client.rowCount("sorted_trends")).toBe(3); // header + 2 sets
      const flags = (client.tabs.get("sorted_trends") ?? []).slice(1).map((row) => row[23]);
      expect(flags).toEqual(["FALSE", "TRUE"]);
    } finally {
      db.close();
    }
  });

  it("throws readably with no persisted items for the date", async () => {
    const db = openTestDb();
    try {
      const orch = new Orchestrator({
        db,
        config,
        log,
        sheetsClient: new FakeSheetsClient(),
        sheetsQueue: fastQueue(),
        fetchImpl: hnFetch(),
        jevClient: jevStub(),
      });
      await expect(orch.resortRun("2026-01-01")).rejects.toThrow(/no persisted items/);
    } finally {
      db.close();
    }
  });
});
