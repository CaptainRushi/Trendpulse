import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { acquirePipelineLock, releasePipelineLock } from "../../src/scheduler/lock.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { LlmClient } from "../../src/llm/client.js";
import { insertRun } from "../pipeline/helpers.js";
import { writeSetting } from "../../src/config/settings.js";
import { testContext } from "./helpers.js";
import type { TestApi } from "./helpers.js";

function hnFetch(): typeof fetch {
  const impl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/topstories.json")) {
      return Promise.resolve(new Response("[11]", { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 11,
          type: "story",
          title: "HN story",
          url: "https://hn.example.com/11",
          score: 10,
          descendants: 1,
          time: 1759200000,
          by: "tester",
        }),
        { status: 200 },
      ),
    );
  };
  return impl;
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

function runnable(t: TestApi): TestApi["ctx"] {
  return { ...t.ctx, fetchImpl: hnFetch(), ...sorterStubs() };
}

async function waitForStatus(
  app: FastifyInstance,
  runId: string,
  timeoutMs = 20000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const status = res.json<{ run: { status: string } }>().run.status;
    if (status === "success" || status === "partial" || status === "failed") return status;
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} still pending`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("POST /api/runs", () => {
  it("starts a run in background (202) that completes with full detail", async () => {
    const t = testContext();
    try {
      const app = await buildApp(runnable(t));
      try {
        const started = await app.inject({
          method: "POST",
          url: "/api/runs",
          payload: { sources: ["hackernews"] },
        });
        expect(started.statusCode).toBe(202);
        const runId = started.json<{ run_id: string }>().run_id;
        expect(typeof runId).toBe("string");

        expect(await waitForStatus(app, runId)).toBe("success");
        const detail = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
        const body = detail.json<{
          run: { status: string; items_collected: number; topics_count: number };
          stages: { stage: string; status: string }[];
          source_stats: { source: string; status: string; items: number; duration_ms: number; error: string | null }[];
          llm: { calls: number };
        }>();
        expect(body.run).toMatchObject({ status: "success", items_collected: 1, topics_count: 1 });
        expect(body.stages).toHaveLength(11);
        expect(body.stages.every((s) => s.status === "done")).toBe(true);
        expect(body.source_stats).toHaveLength(1);
        const stat = body.source_stats[0];
        expect(stat).toMatchObject({ source: "hackernews", status: "ok", items: 1, error: null });
        expect(typeof stat?.duration_ms).toBe("number");
        expect(body.llm.calls).toBe(0); // stub client bypasses llm_calls logging
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("rejects bad bodies with VALIDATION and busy pipelines with 409", async () => {
    const t = testContext();
    try {
      const app = await buildApp(runnable(t));
      try {
        for (const payload of [
          { stages: ["nope"] },
          { sources: ["nope"] },
          { date: "yesterday" },
          { limit: 0 },
          { stages: "collect" },
        ]) {
          const res = await app.inject({ method: "POST", url: "/api/runs", payload });
          expect(res.statusCode).toBe(400);
          expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
        }
        acquirePipelineLock(t.db, "run-holder");
        try {
          // An empty body defaults to my_categories so the request reaches
          // the lock (rather than the NO_CATEGORIES preflight).
          writeSetting(t.db, "my_categories", ["ai"]);
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
});

describe("GET /api/runs", () => {
  it("paginates newest-first with totals", async () => {
    const t = testContext();
    try {
      insertRun(t.db, "run-a", "2026-09-28");
      insertRun(t.db, "run-b", "2026-09-29");
      insertRun(t.db, "run-c", "2026-09-30");
      const app = await buildApp(t.ctx);
      try {
        const all = await app.inject({ method: "GET", url: "/api/runs" });
        const body = all.json<{ runs: { run_id: string }[]; total: number }>();
        expect(body.total).toBe(3);
        expect(body.runs).toHaveLength(3);
        const paged = await app.inject({ method: "GET", url: "/api/runs?limit=1&offset=1" });
        expect(paged.json<{ total: number; runs: unknown[] }>().total).toBe(3);
        expect(paged.json<{ runs: unknown[] }>().runs).toHaveLength(1);
        const bad = await app.inject({ method: "GET", url: "/api/runs?limit=x" });
        expect(bad.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("404s unknown runs and guards retry state", async () => {
    const t = testContext();
    try {
      const app = await buildApp(runnable(t));
      try {
        expect((await app.inject({ method: "GET", url: "/api/runs/nope" })).statusCode).toBe(404);
        const retryMissing = await app.inject({ method: "POST", url: "/api/runs/nope/retry", payload: {} });
        expect(retryMissing.statusCode).toBe(404);

        insertRun(t.db, "run-ok", "2026-09-30");
        t.db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-ok'").run();
        const retryDone = await app.inject({ method: "POST", url: "/api/runs/run-ok/retry", payload: {} });
        expect(retryDone.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});

describe("GET /api/runs/:id/stream", () => {
  it("404s unknown runs; replays history and closes on done", async () => {
    const t = testContext();
    try {
      insertRun(t.db, "run-sse", "2026-09-30");
      t.ctx.events?.emit("run-sse", "stage", { stage: "collect", status: "done" });
      t.ctx.events?.emit("run-sse", "done", { status: "success" });
      const app = await buildApp(t.ctx);
      try {
        const missing = await app.inject({ method: "GET", url: "/api/runs/nope/stream" });
        expect(missing.statusCode).toBe(404);

        const res = await app.inject({ method: "GET", url: "/api/runs/run-sse/stream" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.body).toContain("event: stage");
        expect(res.body).toContain("event: done");
        expect(res.body).toContain("run-sse");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
