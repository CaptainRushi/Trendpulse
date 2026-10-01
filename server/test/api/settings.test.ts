import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { PipelineScheduler } from "../../src/scheduler/cron.js";
import { testContext } from "./helpers.js";

describe("settings", () => {
  it("returns effective values with masked secrets", async () => {
    const t = testContext({
      config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet", OMNIROUTE_API_KEY: "should-not-leak" }),
    });
    try {
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/settings" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ settings: Record<string, { value: unknown; is_set: boolean; secret: boolean; source: string }> }>();
        expect(body.settings["top_n"]).toMatchObject({ value: 50, secret: false, source: "env" });
        expect(body.settings["omniroute_api_key"]).toMatchObject({
          value: "••••",
          is_set: true,
          secret: true,
        });
        expect(body.settings["github_token"]).toMatchObject({ value: "", is_set: false });
        expect(res.body).not.toContain("should-not-leak");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("PUT updates values and reads them back", async () => {
    const t = testContext();
    try {
      const app = buildApp(t.ctx);
      try {
        const res = await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: { top_n: 25, niches: ["ai"], score_weights: { engagement: 0.5, diversity: 0.2, relevance: 0.2, novelty: 0.1 } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ updated: string[] }>().updated.sort()).toEqual([
          "niches",
          "score_weights",
          "top_n",
        ]);
        const back = await app.inject({ method: "GET", url: "/api/settings" });
        const settings = back.json<{ settings: Record<string, { value: unknown; source: string }> }>().settings;
        expect(settings["top_n"]).toMatchObject({ value: 25, source: "settings" });
        expect(settings["niches"]).toMatchObject({ value: ["ai"] });
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("rejects secrets, unknown keys and bad types", async () => {
    const t = testContext();
    try {
      const app = buildApp(t.ctx);
      try {
        for (const payload of [
          { omniroute_api_key: "x" },
          { nope: 1 },
          { top_n: "many" },
          { top_n: -1 },
          { retention_mode: "shred" },
          { niches: "ai" },
        ]) {
          const res = await app.inject({ method: "PUT", url: "/api/settings", payload });
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

  it("hot-restarts the scheduler on schedule changes when present", async () => {
    const t = testContext();
    try {
      const scheduler = new PipelineScheduler({
        cronExpression: "0 6 * * *",
        timezone: "UTC",
        onTrigger: () => Promise.resolve(),
      });
      const app = buildApp({ ...t.ctx, scheduler });
      try {
        const res = await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: { schedule_cron: "0 7 * * *" },
        });
        expect(res.json<{ scheduler_restarted: boolean }>().scheduler_restarted).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
