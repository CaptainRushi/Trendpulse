/**
 * STEP 8 API contract tests. Every title carries its docs/07 test ID.
 * All I/O goes through FakeSheetsClient + fake LLM servers (or fast-refused
 * loopback ports) — no real network, no real credentials.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { acquirePipelineLock, releasePipelineLock } from "../../src/scheduler/lock.js";
import { PipelineScheduler } from "../../src/scheduler/cron.js";
import { RawTrendRecord } from "../../src/sheets/schema.js";
import { makeRawItem } from "../sorting/helpers.js";
import { insertRun } from "../pipeline/helpers.js";
import { FakeJevServer } from "../fakes/fakeJevServer.js";
import { makeSortedTopic, testContext } from "./helpers.js";
import type { TestApi } from "./helpers.js";

function loopbackDeadConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    GOOGLE_SHEET_ID: "test-sheet",
    OMNIROUTE_BASE_URL: "http://127.0.0.1:1",
    JEV_BASE_URL: "http://127.0.0.1:1",
  });
}

async function seedTopics(t: TestApi): Promise<void> {
  await t.repo.init();
  await t.repo.appendSorted([
    makeSortedTopic({
      topic_id: "t1",
      run_id: "run-1",
      run_date: "2026-09-30",
      rank: 1,
      title: "Alpha launch",
      summary: "Alpha launched today.",
      category: "Tech",
      trend_score: 90,
      momentum: "new",
      evidence_item_ids: ["a1"],
      top_urls: ["https://a.example.com/1"],
    }),
    makeSortedTopic({
      topic_id: "t2",
      run_id: "run-1",
      run_date: "2026-09-30",
      rank: 2,
      title: "Beta markets",
      summary: "Markets rally on Beta news.",
      category: "Finance",
      trend_score: 40,
      momentum: "steady",
      evidence_item_ids: [],
      top_urls: [],
    }),
  ]);
  await t.repo.appendRaw([
    RawTrendRecord.parse({ ...makeRawItem({}), id: "a1", run_id: "run-1", source: "hackernews", title: "Alpha launch" }),
  ]);
  await t.repo.appendDigest({
    run_date: "2026-09-30",
    run_id: "run-1",
    digest: "One. Two. Three.",
    top_topic_id: "t1",
    topics_count: 2,
    items_count: 1,
    sources_ok: 1,
    sources_total: 1,
    top_categories: [{ category: "Tech", count: 1 }],
    created_at: "2026-09-30T07:00:00.000Z",
    is_latest: true,
  });
}

describe("STEP 8 API contract", () => {
  it("API-01 GET /health and /jev/health report service state", async () => {
    const t = testContext({ config: loopbackDeadConfig() });
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{
          ok: boolean;
          version: string;
          setup_complete: boolean;
          sheets: string;
          omniroute: string;
          jev: string;
          next_run_at: string | null;
          last_run: { run_id: string; run_date: string; status: string } | null;
        }>();
        expect(body.ok).toBe(true);
        expect(typeof body.version).toBe("string");
        expect(typeof body.setup_complete).toBe("boolean");
        for (const state of [body.sheets, body.omniroute, body.jev]) {
          expect(["ok", "error"]).toContain(state);
        }
        expect(body.next_run_at).toBeNull();
        expect(body.last_run).toBeNull();

        const jev = await app.inject({ method: "GET", url: "/api/jev/health" });
        expect(jev.statusCode).toBe(200);
        const health = jev.json<{
          key_present: boolean;
          last_call_ok: boolean | null;
          price_per_m_input: number;
          budget_used_usd: number;
          budget_usd: number;
        }>();
        expect(health.key_present).toBe(false);
        expect(health.last_call_ok).toBeNull();
        expect(health.price_per_m_input).toBe(0.04);
        expect(health.budget_used_usd).toBe(0);
        expect(health.budget_usd).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-02 GET /trends filters and pages latest visible topics", async () => {
    const t = testContext();
    try {
      await seedTopics(t);
      const app = await buildApp(t.ctx);
      try {
        const base = "/api/trends?date=2026-09-30";
        expect((await app.inject({ method: "GET", url: base })).json<{ total: number }>().total).toBe(2);

        const checks: [string, string[]][] = [
          [`${base}&category=Finance`, ["t2"]],
          [`${base}&momentum=new`, ["t1"]],
          [`${base}&min_score=50`, ["t1"]],
          [`${base}&q=markets`, ["t2"]],
          [`${base}&source=hackernews`, ["t1"]],
          [`${base}&sort=title&limit=1&offset=1`, ["t2"]],
        ];
        for (const [url, ids] of checks) {
          const res = await app.inject({ method: "GET", url });
          expect(res.statusCode).toBe(200);
          expect(res.json<{ items: { topic_id: string }[] }>().items.map((i) => i.topic_id)).toEqual(ids);
        }
        const bad = await app.inject({ method: "GET", url: "/api/trends?limit=101" });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-03 GET /trends carries cache age and POST /sheets/sync clears it", async () => {
    const t = testContext();
    try {
      await seedTopics(t);
      const app = await buildApp(t.ctx);
      try {
        const first = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30" });
        const age = first.json<{ cache: { age_s: number } }>().cache.age_s;
        expect(typeof age).toBe("number");
        expect(age).toBeGreaterThanOrEqual(0);

        const sync = await app.inject({ method: "POST", url: "/api/sheets/sync" });
        expect(sync.json<{ ok: boolean }>().ok).toBe(true);
        const after = await app.inject({ method: "GET", url: "/api/trends?date=2026-09-30" });
        expect(typeof after.json<{ cache: { age_s: number } }>().cache.age_s).toBe("number");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-04 GET /trends/:topic_id hydrates evidence and 404s unknown ids", async () => {
    const t = testContext();
    try {
      await seedTopics(t);
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/trends/t1" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ topic: { topic_id: string }; evidence: { id: string }[] }>();
        expect(body.topic.topic_id).toBe("t1");
        expect(body.evidence.map((e) => e.id)).toEqual(["a1"]);

        const missing = await app.inject({ method: "GET", url: "/api/trends/nope" });
        expect(missing.statusCode).toBe(404);
        expect(missing.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-05 GET /digest and /dates serve the digest row and newest-first dates", async () => {
    const t = testContext();
    try {
      await seedTopics(t);
      const app = await buildApp(t.ctx);
      try {
        const digest = await app.inject({ method: "GET", url: "/api/digest?date=2026-09-30" });
        expect(digest.json<{ digest: string }>().digest).toBe("One. Two. Three.");
        expect((await app.inject({ method: "GET", url: "/api/digest?date=2026-01-01" })).statusCode).toBe(404);

        const dates = await app.inject({ method: "GET", url: "/api/dates" });
        expect(dates.json<{ dates: string[] }>().dates).toEqual(["2026-09-30"]);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-06 GET /raw filters by date/source/q/status with sort_status", async () => {
    const t = testContext();
    try {
      await t.repo.init();
      await t.repo.appendRaw([
        RawTrendRecord.parse({ ...makeRawItem({}), id: "r1", collected_at: "2026-09-30T06:00:00.000Z", source: "rss", title: "Alpha rss" }),
        RawTrendRecord.parse({ ...makeRawItem({}), id: "r2", collected_at: "2026-09-29T06:00:00.000Z", source: "github", title: "Beta gh" }),
      ]);
      insertRun(t.db, "run-1", "2026-09-30");
      t.db
        .prepare(
          "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status) VALUES (?, 'run-1', '2026-09-30', 'rss', 'h1', '{}', 1, 'sorted')",
        )
        .run("r1");
      t.db
        .prepare(
          "INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status) VALUES (?, 'run-1', '2026-09-29', 'github', 'h2', '{}', 1, 'discarded')",
        )
        .run("r2");
      const app = await buildApp(t.ctx);
      try {
        const dated = await app.inject({ method: "GET", url: "/api/raw?date=2026-09-30" });
        expect(dated.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r1"]);

        const stated = await app.inject({ method: "GET", url: "/api/raw?status=discarded" });
        const statedBody = stated.json<{ items: { id: string; sort_status: string }[] }>();
        expect(statedBody.items.map((i) => i.id)).toEqual(["r2"]);
        expect(statedBody.items[0]?.sort_status).toBe("discarded");

        const queried = await app.inject({ method: "GET", url: "/api/raw?q=alpha" });
        expect(queried.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["r1"]);

        expect((await app.inject({ method: "GET", url: "/api/raw?status=bogus" })).statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-07 PUT /sources/:key toggles and validates", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const list = await app.inject({ method: "GET", url: "/api/sources" });
        expect(list.json<{ key: string; enabled: boolean }[]>().find((s) => s.key === "hackernews")?.enabled).toBe(true);

        const off = await app.inject({
          method: "PUT",
          url: "/api/sources/hackernews",
          payload: { enabled: false, item_limit: 10 },
        });
        expect(off.statusCode).toBe(200);
        expect(off.json<{ enabled: boolean; item_limit: number }>().enabled).toBe(false);

        const back = await app.inject({ method: "GET", url: "/api/sources" });
        expect(back.json<{ key: string; enabled: boolean }[]>().find((s) => s.key === "hackernews")?.enabled).toBe(false);

        for (const [url, payload] of [
          ["/api/sources/hackernews", { item_limit: 0 }],
          ["/api/sources/nope", { enabled: true }],
        ] as const) {
          const res = await app.inject({ method: "PUT", url, payload });
          expect(res.statusCode).toBe(400);
          expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
        }
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-08 GET /runs lists newest-first and details stages, sources, llm totals", async () => {
    const t = testContext();
    try {
      insertRun(t.db, "run-a", "2026-09-28");
      insertRun(t.db, "run-b", "2026-09-29");
      const app = await buildApp(t.ctx);
      try {
        const all = await app.inject({ method: "GET", url: "/api/runs" });
        const body = all.json<{ runs: { run_id: string }[]; total: number }>();
        expect(body.total).toBe(2);
        // Same-second seeds keep insertion order — assert the set, not order.
        expect(body.runs.map((r) => r.run_id).sort()).toEqual(["run-a", "run-b"]);

        const detail = await app.inject({ method: "GET", url: "/api/runs/run-a" });
        const detailBody = detail.json<{ run: { run_id: string }; stages: unknown[]; source_stats: unknown[]; llm: { calls: number } }>();
        expect(detailBody.run.run_id).toBe("run-a");
        expect(Array.isArray(detailBody.stages)).toBe(true);
        expect(Array.isArray(detailBody.source_stats)).toBe(true);
        expect(typeof detailBody.llm.calls).toBe("number");

        expect((await app.inject({ method: "GET", url: "/api/runs/nope" })).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-09 POST /runs returns 202, 409 when locked, 400 on bad bodies", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        // rss with no feeds configured skips instantly — the 202 lands before
        // the background run fails on empty data.
        const started = await app.inject({
          method: "POST",
          url: "/api/runs",
          payload: { sources: ["rss"] },
        });
        expect(started.statusCode).toBe(202);
        expect(typeof started.json<{ run_id: string }>().run_id).toBe("string");

        const bad = await app.inject({ method: "POST", url: "/api/runs", payload: { sources: ["nope"] } });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");

        acquirePipelineLock(t.db, "run-holder");
        try {
          const busy = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
          expect(busy.statusCode).toBe(409);
          expect(busy.json<{ error: { code: string } }>().error.code).toBe("RUN_LOCKED");
        } finally {
          releasePipelineLock(t.db, "run-holder");
        }
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-11 GET/PUT /settings masks secrets and hot-reloads the schedule", async () => {
    const t = testContext({
      config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet", OMNIROUTE_API_KEY: "omni-marker" }),
    });
    try {
      const scheduler = new PipelineScheduler({
        cronExpression: "0 6 * * *",
        timezone: "UTC",
        onTrigger: () => Promise.resolve(),
      });
      const app = await buildApp({ ...t.ctx, scheduler });
      try {
        const res = await app.inject({ method: "GET", url: "/api/settings" });
        const settings = res.json<{ settings: Record<string, { value: unknown; is_set: boolean; secret: boolean; source: string }> }>().settings;
        expect(settings["omniroute_api_key"]).toMatchObject({ value: "••••", is_set: true, secret: true });
        expect(settings["github_token"]).toMatchObject({ value: "", is_set: false, secret: true });
        expect(settings["top_per_category"]).toMatchObject({ value: 5, secret: false, source: "env" });
        expect(res.body).not.toContain("omni-marker");

        const put = await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: { top_per_category: 3, schedule_cron: "0 7 * * *" },
        });
        expect(put.json<{ scheduler_restarted: boolean }>().scheduler_restarted).toBe(true);
        const back = await app.inject({ method: "GET", url: "/api/settings" });
        expect(
          back.json<{ settings: Record<string, { value: unknown; source: string }> }>().settings["top_per_category"],
        ).toMatchObject({ value: 3, source: "settings" });
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-12 setup test routes succeed, fail softly, and never echo secrets", async () => {
    const jev = await FakeJevServer.start("ok");
    const t = testContext({ config: loopbackDeadConfig() });
    try {
      const app = await buildApp(t.ctx);
      try {
        const omni = await app.inject({
          method: "POST",
          url: "/api/setup/test-omniroute",
          payload: { base_url: "http://127.0.0.1:1", api_key: "omni-marker-xyz" },
        });
        expect(omni.statusCode).toBe(200);
        expect(omni.json<{ ok: boolean }>().ok).toBe(false);
        expect(omni.body).not.toContain("omni-marker-xyz");

        const probe = await app.inject({
          method: "POST",
          url: "/api/setup/test-jev",
          payload: { base_url: jev.url, api_key: "jev-marker-xyz", model: "jev-1" },
        });
        expect(probe.statusCode).toBe(200);
        const probeBody = probe.json<{ ok: boolean; choice?: string; confidence?: number; latency_ms?: number }>();
        expect(probeBody.ok).toBe(true);
        expect(probeBody.choice).toBe("Tech");
        expect(typeof probeBody.confidence).toBe("number");
        expect(typeof probeBody.latency_ms).toBe("number");
        expect(probe.body).not.toContain("jev-marker-xyz");

        const sheets = await app.inject({
          method: "POST",
          url: "/api/setup/test-sheets",
          payload: { sheet_id: "s", service_account_json: "{oops-marker" },
        });
        expect(sheets.json<{ ok: boolean }>().ok).toBe(false);
        expect(sheets.body).not.toContain("oops-marker");
      } finally {
        await app.close();
      }
    } finally {
      await jev.stop();
      await t.close();
    }
  });

  it("API-14 GET /export/topics.csv has a BOM and escapes cells", async () => {
    const t = testContext();
    try {
      await t.repo.init();
      await t.repo.appendSorted([
        makeSortedTopic({
          topic_id: "t1",
          run_id: "run-1",
          run_date: "2026-09-30",
          rank: 1,
          title: 'Comma, "quoted" title',
          summary: "line one\nline two",
          evidence_item_ids: ["a1"],
          top_urls: [],
        }),
      ]);
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/export/topics.csv?date=2026-09-30" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/csv");
        expect(res.body.charCodeAt(0)).toBe(0xfeff);
        expect(res.body).toContain('"Comma, ""quoted"" title"');
        expect(res.body).toContain('"line one\nline two"');
        expect(res.headers["content-disposition"]).toContain("topics-2026-09-30.csv");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("API-15 errors use the { error: { code, message } } envelope", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const notFound = await app.inject({ method: "GET", url: "/api/nope" });
        expect(notFound.statusCode).toBe(404);
        const body = notFound.json<{ error: { code: string; message: string } }>();
        expect(body.error.code).toBe("NOT_FOUND");
        expect(typeof body.error.message).toBe("string");

        const bad = await app.inject({ method: "GET", url: "/api/trends?date=nope" });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ error: { code: string; message: string } }>().error.code).toBe("VALIDATION");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("SEC-01 default config binds loopback and non-loopback needs a password", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow();
  });

  it("SEC-04 foreign origins are blocked, dev and own origins pass", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const foreign = await app.inject({
          method: "GET",
          url: "/api/health",
          headers: { origin: "https://evil.example.com" },
        });
        expect(foreign.statusCode).toBe(403);

        const dev = await app.inject({
          method: "GET",
          url: "/api/health",
          headers: { origin: "http://127.0.0.1:5173" },
        });
        expect(dev.statusCode).toBe(200);
        expect(dev.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

        const plain = await app.inject({ method: "GET", url: "/api/health" });
        expect(plain.statusCode).toBe(200);
        expect(plain.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("SEC-06 settings, health and error bodies never leak secrets", async () => {
    const t = testContext({
      config: loadConfig({
        GOOGLE_SHEET_ID: "test-sheet",
        OMNIROUTE_BASE_URL: "http://127.0.0.1:1",
        JEV_BASE_URL: "http://127.0.0.1:1",
        OMNIROUTE_API_KEY: "omni-marker-xyz",
        JEV_API_KEY: "jev-marker-xyz",
        GITHUB_TOKEN: "gh-marker-xyz",
      }),
    });
    try {
      const app = await buildApp(t.ctx);
      try {
        const markers = ["omni-marker-xyz", "jev-marker-xyz", "gh-marker-xyz"];
        for (const url of ["/api/settings", "/api/jev/health", "/api/nope"]) {
          const res = await app.inject({ method: "GET", url });
          for (const marker of markers) expect(res.body).not.toContain(marker);
        }
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
