/**
 * Step-7 scheduler contract (docs/12 Prompt 7). Titles start with the test ID
 * per CLAUDE.md rule 9.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { Orchestrator } from "../../src/pipeline/orchestrator.js";
import { PipelineScheduler } from "../../src/scheduler/cron.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import type { Classifier } from "../../src/llm/classifier.js";
import { LlmClient } from "../../src/llm/client.js";
import { FakeSheetsClient } from "../fakes/fakeSheetsClient.js";
import { insertRun, openTestDb } from "../pipeline/helpers.js";

const DAY = "2026-09-30";

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

function hnFetch(): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/topstories.json")) return Promise.resolve(new Response("[11]", { status: 200 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: 11, type: "story", title: "Catchup story", url: "https://hn.example.com/11", score: 5, descendants: 1, time: 1759200000, by: "t" }),
        { status: 200 },
      ),
    );
  });
}

describe("STEP 7 scheduler", () => {
  it("RUN-09 cron fires on schedule", async () => {
    const onTrigger = vi.fn(() => Promise.resolve());
    const scheduler = new PipelineScheduler({
      cronExpression: "* * * * * *",
      timezone: "UTC",
      onTrigger,
    });
    scheduler.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(onTrigger).toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
    expect(scheduler.running).toBe(false);
  });

  it("RUN-10 catch-up runs when today has no success", async () => {
    const db = openTestDb();
    try {
      const scheduler = new PipelineScheduler({
        cronExpression: "0 6 * * *",
        timezone: "UTC",
        onTrigger: () => Promise.resolve(),
      });
      expect(scheduler.needsCatchup(db, DAY)).toBe(true);
      const orch = new Orchestrator({
        db,
        config: loadConfig({}),
        log: pino({ level: "silent" }),
        sheetsClient: new FakeSheetsClient(),
        sheetsQueue: new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() }),
        fetchImpl: hnFetch(),
        ...sorterStubs(),
      });
      const summary = await orch.startRun({ trigger: "catchup", runDate: DAY, sources: ["hackernews"] });
      expect(summary.status).toBe("success");
      expect(scheduler.needsCatchup(db, DAY)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("RUN-10 catch-up is skipped after a successful run", async () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-ok", DAY);
      db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-ok'").run();
      const scheduler = new PipelineScheduler({
        cronExpression: "0 6 * * *",
        timezone: "UTC",
        onTrigger: () => Promise.resolve(),
      });
      expect(scheduler.needsCatchup(db, DAY)).toBe(false);
    } finally {
      db.close();
    }
  });
});
