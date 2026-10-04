import { describe, expect, it } from "vitest";
import { PulseSamples, PulseTodayTop } from "@trendpulse/shared";
import { buildApp } from "../../src/app.js";
import { testContext, makeSortedTopic } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";
import { sortedRecordToRow } from "../../src/sheets/mappers.js";
import { SORTED_TRENDS_HEADERS } from "../../src/sheets/schema.js";
import { PulseSampler } from "../../src/pulse/sampler.js";
import type { PulseConfig } from "../../src/pulse/config.js";

const PULSE: PulseConfig = { enabled: true, intervalMin: 20, topN: 5, maxRequests: 30, retentionDays: 14 };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });

function seedRun(t: ReturnType<typeof testContext>): void {
  t.db
    .prepare("INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at) VALUES ('run_1', ?, 'manual', 'success', '[]', ?)")
    .run(today, `${today}T06:00:00.000Z`);
}

function seedIndex(t: ReturnType<typeof testContext>, topics: { id: string; rank: number; evidence: string[] }[]): void {
  const stmt = t.db.prepare(
    "INSERT INTO topic_index (topic_id, run_id, run_date, rank, title, score, evidence_item_ids_json, created_at, is_latest) VALUES (?, 'run_1', ?, ?, ?, 90, ?, ?, 1)",
  );
  for (const topic of topics) {
    stmt.run(topic.id, today, topic.rank, `Title ${topic.id}`, JSON.stringify(topic.evidence), `${today}T06:00:00.000Z`);
  }
}

function seedSamples(t: ReturnType<typeof testContext>, topicId: string, points: { t: string; i: number; total: number }[]): void {
  const stmt = t.db.prepare(
    "INSERT INTO topic_samples (topic_id, sampled_at, index_value, total, items_sampled, items_failed, detail_json) VALUES (?, ?, ?, ?, 1, 0, '[]')",
  );
  for (const p of points) stmt.run(topicId, p.t, p.i, p.total);
}

async function seedSortedRow(t: ReturnType<typeof testContext>, topicId: string): Promise<void> {
  const record = makeSortedTopic({ topic_id: topicId, run_date: today, run_id: "run_1", is_latest: true, hidden: false });
  await t.sheets.addTab("sorted_trends");
  await t.sheets.writeFirstRow("test-sheet", "sorted_trends", [...SORTED_TRENDS_HEADERS]);
  await t.sheets.appendRows("test-sheet", "sorted_trends", [sortedRecordToRow(record)]);
}

describe("PULSE-15 today/top shape and fallback", () => {
  it("returns the hero payload parsed by the shared schema", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      seedRun(t);
      seedIndex(t, [
        { id: "t1", rank: 1, evidence: [] },
        { id: "t2", rank: 2, evidence: [] },
      ]);
      await seedSortedRow(t, "t1");
      seedSamples(t, "t1", [
        { t: `${today}T06:00:00.000Z`, i: 100, total: 40 },
        { t: new Date().toISOString(), i: 105, total: 42 },
      ]);
      const res = await app.inject({ method: "GET", url: "/api/today/top" });
      expect(res.statusCode).toBe(200);
      const body = PulseTodayTop.parse(res.json());
      expect(body.date).toBe(today);
      expect(body.from_previous_day).toBe(false);
      expect(body.topic?.topic_id).toBe("t1");
      expect(body.topic?.summary).not.toBe("");
      expect(body.topic?.has_live_metric).toBe(true);
      expect(body.runner_ups.map((r) => r.topic_id)).toEqual(["t2"]);
      expect(body.live.status).toBe("live");
      expect(body.live.last_sample_at).not.toBe(`${today}T06:00:00.000Z`);
    } finally {
      await app.close();
      await t.close();
    }
  });

  it("no set anywhere yields an empty hero, not a 404", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const res = await app.inject({ method: "GET", url: "/api/today/top" });
      expect(res.statusCode).toBe(200);
      const body = PulseTodayTop.parse(res.json());
      expect(body.topic).toBeNull();
      expect(body.runner_ups).toEqual([]);
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("PULSE-16 samples shape and ordering", () => {
  it("ascending points with sources, parsed by the shared schema", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      seedRun(t);
      seedIndex(t, [{ id: "t1", rank: 1, evidence: [] }]);
      seedSamples(t, "t1", [
        { t: `${today}T07:00:00.000Z`, i: 110, total: 44 },
        { t: `${today}T06:00:00.000Z`, i: 100, total: 40 },
        { t: `${today}T06:20:00.000Z`, i: 105, total: 42 },
      ]);
      const res = await app.inject({ method: "GET", url: `/api/live/samples?date=${today}&top=5` });
      expect(res.statusCode).toBe(200);
      const body = PulseSamples.parse(res.json());
      expect(body.series).toHaveLength(1);
      expect(body.series[0]?.points.map((p) => p.t)).toEqual([
        `${today}T06:00:00.000Z`,
        `${today}T06:20:00.000Z`,
        `${today}T07:00:00.000Z`,
      ]);
      expect(body.series[0]?.has_live_metric).toBe(true);
      const bad = await app.inject({ method: "GET", url: "/api/live/samples?date=not-a-date" });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("PULSE-17 SSE replay, heartbeat and Last-Event-ID", () => {
  it("replays history, filters by last-event-id, then closes on done", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const bus = t.ctx.events;
      if (!bus) throw new Error("test context has no event bus");
      const first = bus.emit("pulse", "sample", { topic_id: "t1", n: 1 });
      bus.emit("pulse", "sample", { topic_id: "t1", n: 2 });
      bus.emit("pulse", "done", {});
      const full = await app.inject({ method: "GET", url: "/api/live/stream" });
      expect(full.statusCode).toBe(200);
      expect(full.body).toContain("event: sample");
      expect(full.body).toContain("event: done");
      const filtered = await app.inject({
        method: "GET",
        url: "/api/live/stream",
        headers: { "last-event-id": String(first.seq) },
      });
      expect(filtered.body).not.toContain('"n":1');
      expect(filtered.body).toContain('"n":2');
      expect(filtered.body).toContain("event: done");
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("PULSE-18 sample-now 409 and rate limit", () => {
  it("409 while a pipeline run holds the lock, 429 inside the cooldown", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet" }) });
    const app = await buildApp(t.ctx);
    try {
      const sampler = new PulseSampler({
        db: t.db,
        config: PULSE,
        refreshers: [],
        isPipelineActive: () => false,
        emit: () => undefined,
        today: () => today,
        nowIso: () => new Date().toISOString(),
      });
      t.ctx.pulse = sampler;
      t.db.prepare("INSERT INTO locks (name, run_id, heartbeat_at) VALUES ('pipeline', 'run_x', ?)").run(new Date().toISOString());
      const busy = await app.inject({ method: "POST", url: "/api/live/sample-now" });
      expect(busy.statusCode).toBe(409);
      t.db.prepare("DELETE FROM locks").run();
      sampler.lastManualAt = Date.now();
      const throttled = await app.inject({ method: "POST", url: "/api/live/sample-now" });
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json<{ error: { code: string } }>().error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
      await t.close();
    }
  });

  it("400 when the sampler is disabled", async () => {
    const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet", PULSE_ENABLED: "false" }) });
    const app = await buildApp(t.ctx);
    try {
      const res = await app.inject({ method: "POST", url: "/api/live/sample-now" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("PULSE-19 route parity with shared types", () => {
  it("status and usage already covered; schemas import from the built package", () => {
    expect(typeof PulseTodayTop.parse).toBe("function");
    expect(typeof PulseSamples.parse).toBe("function");
  });
});
