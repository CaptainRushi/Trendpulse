import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { insertRun } from "./pipeline/helpers.js";
import { testContext } from "./api/helpers.js";

describe("GET /api/health", () => {
  it("returns the full contract with dependency states", async () => {
    // Hermetic: the LLM probes must fail by construction (discard port),
    // not because the developer happens to have no gateway running.
    const t = testContext({
      config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet", OMNIROUTE_BASE_URL: "http://127.0.0.1:9/v1" }),
    });
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json<Record<string, unknown>>();
        expect(body["ok"]).toBe(true);
        expect(body["version"]).toBe("0.1.0-test");
        expect(body["setup_complete"]).toBe(false);
        // Fake sheets answers; nothing listens on the LLM ports here.
        expect(body["sheets"]).toBe("ok");
        expect(body["omniroute"]).toBe("error");
        expect(body["jev"]).toBe("error");
        expect(body["next_run_at"]).toBeNull();
        expect(body["last_run"]).toBeNull();
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("reflects setup_complete and the last run", async () => {
    const t = testContext();
    try {
      t.db.prepare("INSERT INTO settings (key, value_json) VALUES ('setup_complete', 'true')").run();
      insertRun(t.db, "run-9", "2026-09-30");
      t.db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-9'").run();
      const app = await buildApp(t.ctx);
      try {
        const body = (await app.inject({ method: "GET", url: "/api/health" })).json<{
          setup_complete: boolean;
          last_run: { run_id: string; status: string } | null;
        }>();
        expect(body.setup_complete).toBe(true);
        expect(body.last_run).toMatchObject({ run_id: "run-9", status: "success" });
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("never exposes secret values", async () => {
    const t = testContext({
      config: loadConfig({ GOOGLE_SHEET_ID: "test-sheet", OMNIROUTE_API_KEY: "should-not-leak" }),
    });
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        expect(res.body).not.toContain("should-not-leak");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("answers 404 with the error envelope on unknown routes", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/nope" });
        expect(res.statusCode).toBe(404);
        const body = res.json<{ error: { code: string } }>();
        expect(body.error.code).toBe("NOT_FOUND");
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
