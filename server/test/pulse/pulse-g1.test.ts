import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import type { StateDb } from "../../src/db/sqlite.js";
import {
  growthIndex,
  PulseSampler,
  type CycleResult,
  type SamplerDeps,
} from "../../src/pulse/sampler.js";
import {
  latestSet,
  mostRecentDate,
  readBaselines,
  selectTop,
  writeLatestSet,
  type IndexableTopic,
} from "../../src/pulse/index.js";
import type { PulseConfig } from "../../src/pulse/config.js";
import type { Refresher, RefreshItem, RefreshOutcome } from "../../src/pulse/refresh.js";

const CONFIG: PulseConfig = { enabled: true, intervalMin: 20, topN: 5, maxRequests: 30, retentionDays: 14 };

function freshDb(): StateDb {
  const db = openDatabase(":memory:");
  applyMigrations(db);
  db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1', '2026-10-04', 'manual', 'success', '[]', '2026-10-04T06:00:00.000Z')").run();
  return db;
}

function seedItems(db: StateDb, runDate: string, items: { id: string; source: string; url: string; engagement: number }[]): void {
  const stmt = db.prepare("INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json) VALUES (?, 'run_1', ?, ?, ?, ?)");
  for (const item of items) {
    stmt.run(item.id, runDate, item.source, `h-${item.id}`, JSON.stringify({ url: item.url, engagement_score: item.engagement }));
  }
}

function topic(id: string, rank: number, evidence: string[], score = 90 - rank): IndexableTopic {
  return { topic_id: id, rank, title: `Topic ${id}`, trend_score: score, source_count: 2, hidden: false, evidence_item_ids: evidence };
}

/** Refresher stub: number → value, "429" → 429 error, "fail" → generic error. */
type ScriptStep = number | "429" | "fail";

function stubRefresher(source: string, entries: [string, ScriptStep][], calls: string[] = []): Refresher {
  const script = new Map<string, ScriptStep>(entries);
  return {
    source,
    canRefresh: (item) => item.source === source,
    refresh: (items: RefreshItem[]): Promise<RefreshOutcome[]> => {
      calls.push(`${source}:${items.map((i) => i.itemId).join(",")}`);
      return Promise.resolve(
        items.map((item) => {
          const step = script.get(item.itemId);
          if (step === "429") return { itemId: item.itemId, error: "429 too many requests" };
          if (step === "fail" || step === undefined) return { itemId: item.itemId, error: "gone" };
          return { itemId: item.itemId, value: step };
        }),
      );
    },
  };
}

function samplerDeps(db: StateDb, refreshers: Refresher[], over: Partial<PulseConfig> = {}): SamplerDeps & { emitted: { type: string; data: Record<string, unknown> }[] } {
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  return {
    db,
    config: { ...CONFIG, ...over },
    refreshers,
    isPipelineActive: () => false,
    emit: (type, data) => {
      emitted.push({ type, data });
    },
    today: () => "2026-10-04",
    nowIso: () => "2026-10-04T12:00:00.000Z",
    emitted,
  };
}

describe("PULSE-01 growth index math", () => {
  it("100 at baseline, scales linearly, NaN on zero baseline", () => {
    expect(growthIndex(130, 100)).toBe(130);
    expect(growthIndex(100, 100)).toBe(100);
    expect(Number.isNaN(growthIndex(50, 0))).toBe(true);
  });

  it("failed item carries last value forward; all-fail adds no point", async () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [
        { id: "a", source: "hackernews", url: "https://news.ycombinator.com/item?id=1", engagement: 100 },
        { id: "b", source: "hackernews", url: "https://news.ycombinator.com/item?id=2", engagement: 100 },
      ]);
      writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a", "b"])], 5, "2026-10-04T06:00:00.000Z");
      const deps = samplerDeps(db, [stubRefresher("hackernews", [["a", 150], ["b", "fail"]])]);
      const result: CycleResult = await new PulseSampler(deps).runCycle("manual");
      expect(result.status).toBe("ok");
      expect(result.sampled).toBe(1);
      const row = db.prepare("SELECT index_value, total, items_failed FROM topic_samples WHERE topic_id = 't1' ORDER BY sampled_at DESC LIMIT 1").get() as {
        index_value: number;
        total: number;
        items_failed: number;
      };
      expect(row.index_value).toBe(125); // (150 + carried 100) / 200
      expect(row.total).toBe(250);
      expect(row.items_failed).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-02 baseline written at persist, flipped on re-sort", () => {
  it("indexes the set once and flips is_latest on a new run", () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [{ id: "a", source: "github", url: "https://github.com/o/r", engagement: 10 }]);
      const first = writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a"])], 5, "2026-10-04T06:00:00.000Z");
      expect(first).toMatchObject({ indexed: 1, baselined: 1, topChanged: true });
      const baseline = db.prepare("SELECT index_value FROM topic_samples WHERE topic_id = 't1'").get() as { index_value: number };
      expect(baseline.index_value).toBe(100);
      const second = writeLatestSet(db, "run_2", "2026-10-04", [topic("t2", 1, ["a"])], 5);
      expect(second.topChanged).toBe(true);
      const old = db.prepare("SELECT is_latest FROM topic_index WHERE topic_id = 't1'").get() as { is_latest: number };
      expect(old.is_latest).toBe(0);
      expect(mostRecentDate(db)).toBe("2026-10-04");
      expect(latestSet(db, "2026-10-04").map((t) => t.topicId)).toEqual(["t2"]);
      expect(latestSet(db, "2026-10-03")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-03 top-topic selection", () => {
  it("hidden excluded, ties break by score then source_count", () => {
    const hiddenTop: IndexableTopic = { ...topic("h", 1, []), hidden: true };
    const second = topic("s", 2, []);
    expect(selectTop([hiddenTop, second])?.topic_id).toBe("s");
    const tieA: IndexableTopic = { ...topic("a", 1, []), trend_score: 80, source_count: 1 };
    const tieB: IndexableTopic = { ...topic("b", 1, []), trend_score: 80, source_count: 5 };
    expect(selectTop([tieA, tieB])?.topic_id).toBe("b");
    expect(selectTop([])).toBeNull();
  });
});

describe("PULSE-04 cycle skipped while a run is active", () => {
  it("records a skipped cycle and samples nothing", async () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [{ id: "a", source: "hackernews", url: "u", engagement: 5 }]);
      writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a"])], 5, "2026-10-04T06:00:00.000Z");
      const deps = samplerDeps(db, [stubRefresher("hackernews", [["a", 9]])]);
      deps.isPipelineActive = () => true;
      const result = await new PulseSampler(deps).runCycle("timer");
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("run-active");
      expect(db.prepare("SELECT COUNT(*) AS n FROM topic_samples WHERE sampled_at > '2026-10-04T06:00:01Z'").get()).toMatchObject({ n: 0 });
      const cycle = db.prepare("SELECT status FROM pulse_cycles ORDER BY id DESC LIMIT 1").get() as { status: string };
      expect(cycle.status).toBe("timer:skipped:run-active");
    } finally {
      db.close();
    }
  });
});

describe("PULSE-05 request cap", () => {
  it("never attempts more than maxRequests items", async () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [
        { id: "a", source: "hackernews", url: "u1", engagement: 10 },
        { id: "b", source: "hackernews", url: "u2", engagement: 10 },
        { id: "c", source: "github", url: "u3", engagement: 10 },
      ]);
      writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a", "b", "c"])], 5, "2026-10-04T06:00:00.000Z");
      const calls: string[] = [];
      const deps = samplerDeps(
        db,
        [stubRefresher("hackernews", [["a", 11], ["b", 11]], calls), stubRefresher("github", [["c", 11]], calls)],
        { maxRequests: 2 },
      );
      const result = await new PulseSampler(deps).runCycle("manual");
      expect(result.requests).toBeLessThanOrEqual(2);
      expect(result.sampled).toBe(1);
      // Grouped by source: one refresh call per refresher.
      expect(calls.filter((c) => c.startsWith("hackernews:"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-06 429 backoff and per-day source mute", () => {
  it("two 429s mute the source for the rest of the day", async () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [{ id: "a", source: "hackernews", url: "u", engagement: 10 }]);
      writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a"])], 5, "2026-10-04T06:00:00.000Z");
      const deps = samplerDeps(db, [stubRefresher("hackernews", [["a", "429"]])]);
      const sampler = new PulseSampler(deps);
      const first = await sampler.runCycle("manual");
      expect(first.errors).toBe(1); // all items failed → no point
      const second = await sampler.runCycle("manual");
      expect(second.errors).toBe(1);
      const third = await sampler.runCycle("manual");
      expect(third.requests).toBe(0); // muted: not even attempted
      expect(third.skipped).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-07 topic without refreshable items has no series", () => {
  it("skips rss-only topics and stores nothing", async () => {
    const db = freshDb();
    try {
      seedItems(db, "2026-10-04", [{ id: "a", source: "rss", url: "u", engagement: 3 }]);
      const written = writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a"])], 5, "2026-10-04T06:00:00.000Z");
      expect(written.baselined).toBe(0);
      const deps = samplerDeps(db, []);
      const result = await new PulseSampler(deps).runCycle("manual");
      expect(result.skipped).toBe(1);
      expect(result.sampled).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("PULSE-08 retention prune", () => {
  it("deletes samples older than retentionDays", () => {
    const db = freshDb();
    try {
      db.prepare("INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) VALUES ('t', '2020-01-01T00:00:00.000Z', 100, 5, 1, 0, '[]')").run();
      db.prepare("INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) VALUES ('t', ?, 101, 5, 1, 0, '[]')").run(new Date().toISOString());
      const deps = samplerDeps(db, []);
      expect(new PulseSampler(deps).prune()).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM topic_samples").get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe("PULSE-09 sampling path makes no AI/Sheets/Composio calls", () => {
  it("only touches the two refreshable origins", async () => {
    const db = freshDb();
    const hosts: string[] = [];
    try {
      seedItems(db, "2026-10-04", [
        { id: "a", source: "hackernews", url: "https://example.com/x", engagement: 10 },
        { id: "b", source: "github", url: "https://example.com/y", engagement: 10 },
      ]);
      writeLatestSet(db, "run_1", "2026-10-04", [topic("t1", 1, ["a", "b"])], 5, "2026-10-04T06:00:00.000Z");
      // Test-local refreshers: the only network they may touch is their origin.
      const hn: Refresher = {
        source: "hackernews",
        canRefresh: () => true,
        refresh: (items) => {
          hosts.push("hacker-news.firebaseio.com");
          return Promise.resolve(items.map((item) => ({ itemId: item.itemId, value: 11 })));
        },
      };
      const gh: Refresher = {
        source: "github",
        canRefresh: () => true,
        refresh: (items) => {
          hosts.push("api.github.com");
          return Promise.resolve(items.map((item) => ({ itemId: item.itemId, value: 11 })));
        },
      };
      const deps = samplerDeps(db, [hn, gh]);
      const result = await new PulseSampler(deps).runCycle("manual");
      expect(result.sampled).toBe(1);
      expect(hosts.sort()).toEqual(["api.github.com", "hacker-news.firebaseio.com"]);
      expect(readBaselines(db, "2026-10-04").size).toBe(2);
    } finally {
      db.close();
    }
  });
});

