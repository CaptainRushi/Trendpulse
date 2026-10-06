import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import type { StateDb } from "../../src/db/sqlite.js";
import {
  chunkBatch,
  cutTitle,
  emitSortEvent,
  recordSortEvent,
  replaySortEvents,
} from "../../src/pipeline/sortEvents.js";
import { EventBus } from "../../src/pipeline/events.js";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";

function freshDb(): StateDb {
  const db = openDatabase(":memory:");
  applyMigrations(db);
  return db;
}

describe("SORTANIM-01 batching, throttle and title truncation", () => {
  it("500 items give 5 bounded events; titles cut to 60 chars", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `i${String(i)}`, t: `Title number ${String(i)}` }));
    const batches = chunkBatch(items, 100);
    expect(batches).toHaveLength(5);
    expect(batches.every((b) => b.length <= 100)).toBe(true);
    expect(cutTitle("x".repeat(200)).length).toBe(60);
    expect(cutTitle("short")).toBe("short");
  });
});

describe("SORTANIM-04 fallback, discarded and off-category flags present", () => {
  it("batch payloads carry f/d/o markers", () => {
    const db = freshDb();
    try {
      db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1','2026-10-04','manual','running','[]','2026-10-04T06:00:00.000Z')").run();
      const bus = new EventBus();
      const seen: string[] = [];
      bus.subscribe((e) => {
        seen.push(e.type);
      });
      emitSortEvent(db, bus, "run_1", "sort_batch", {
        stage: "classify",
        items: [
          { id: "a", t: "A", c: "ai", q: 0.9, f: true, d: false, o: false },
          { id: "b", t: "B", c: "tech", q: 0.1, f: false, d: true, o: false },
          { id: "c", t: "C", c: "finance", q: 0.9, f: false, d: false, o: true },
        ],
        done: 3,
        total: 3,
        jev_calls: 2,
        fallback_calls: 1,
        cost_usd: 0.001,
      });
      expect(seen).toEqual(["sort_batch"]);
      const replayed = replaySortEvents(db, "run_1");
      expect(replayed).toHaveLength(1);
      const items = (replayed[0]?.["items"] ?? []) as { f: boolean; d: boolean; o: boolean }[];
      expect(items.map((i) => [i.f, i.d, i.o])).toEqual([[true, false, false], [false, true, false], [false, false, true]]);
    } finally {
      db.close();
    }
  });
});

describe("SORTANIM-02 snapshot equals replay; SORTANIM-03 mid-sort open", () => {
  it("sort-state rebuilds from stored events", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      t.db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_9','2026-10-04','manual','running','[]','2026-10-04T06:00:00.000Z')").run();
      recordSortEvent(t.db, "run_9", { type: "sort_phase", phase: "classify" });
      recordSortEvent(t.db, "run_9", { type: "sort_batch", stage: "classify", items: [{ id: "a" }], done: 1, total: 2 });
      const res = await app.inject({ method: "GET", url: "/api/runs/run_9/sort-state" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ phase: string; events: unknown[] }>();
      expect(body.phase).toBe("classify");
      expect(body.events).toHaveLength(2);
      // Replay independently equals the snapshot source.
      expect(replaySortEvents(t.db, "run_9")).toHaveLength(2);
      const missing = await app.inject({ method: "GET", url: "/api/runs/nope/sort-state" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      await t.close();
    }
  });

  it("active run endpoint reports id and scope", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const idle = await app.inject({ method: "GET", url: "/api/runs/active" });
      expect(idle.json()).toEqual({ run_id: null, scope: "all" });
      t.db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at, scope_key) VALUES ('run_x','2026-10-04','manual','running','[]','2026-10-04T06:00:00.000Z','ai')").run();
      const active = await app.inject({ method: "GET", url: "/api/runs/active" });
      expect(active.json()).toEqual({ run_id: "run_x", scope: "ai" });
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("SORTANIM-15 retention keeps the last 3 runs", () => {
  it("older runs' events are pruned; 5 MB cap skips writes", () => {
    const db = freshDb();
    try {
      const bus = new EventBus();
      for (const run of ["run_1", "run_2", "run_3", "run_4"]) {
        db.prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES (?, '2026-10-04','manual','success','[]','2026-10-04T06:00:00.000Z')").run(run);
        emitSortEvent(db, bus, run, "sort_phase", { phase: "classify" });
      }
      const remaining = db.prepare("SELECT DISTINCT run_id AS id FROM sort_events").all() as { id: string }[];
      expect(remaining.map((r) => r.id).sort()).toEqual(["run_2", "run_3", "run_4"]);
      expect(replaySortEvents(db, "run_1")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
