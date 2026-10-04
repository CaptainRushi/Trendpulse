import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import { loadConfig } from "../../src/config/env.js";
import { writeSetting } from "../../src/config/settings.js";

const KEY = "ck_topsecret_value";

async function withApp(
  configOverrides: Record<string, string>,
  fn: (app: Awaited<ReturnType<typeof buildApp>>, t: ReturnType<typeof testContext>) => Promise<void>,
): Promise<void> {
  const t = testContext({ config: loadConfig({ GOOGLE_SHEET_ID: "sheet-1", ...configOverrides }) });
  const app = await buildApp(t.ctx);
  try {
    await fn(app, t);
  } finally {
    await app.close();
    await t.close();
  }
}

describe("API-12 composio routes never echo secrets", () => {
  it("status masks the key and reports blockers", async () => {
    await withApp({ COMPOSIO_API_KEY: "" }, async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/integrations/composio/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body["configured"]).toBe(false);
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(body["blockers"]).toContain("COMPOSIO_NOT_CONFIGURED");
      expect(body["lock_problems"]).toBeInstanceOf(Array);
    });
  });

  it("usage is empty on a fresh install and budget fields exist", async () => {
    await withApp({ COMPOSIO_API_KEY: KEY }, async (app, t) => {
      const res = await app.inject({ method: "GET", url: "/api/integrations/composio/usage" });
      expect(res.json()).toEqual({ budget: { used: 0, limit: 15000 }, calls: [] });
      t.db.prepare("SELECT 1").get();
      writeSetting(t.db, "composio_connection", { status: "ACTIVE", accountId: "acc_1" });
      const status = await app.inject({ method: "GET", url: "/api/integrations/composio/status" });
      const body = status.json<{ connection: { status: string }; blockers: string[] }>();
      expect(body.connection.status).toBe("ACTIVE");
      expect(body.blockers).not.toContain("COMPOSIO_NOT_CONNECTED");
      expect(status.body).not.toContain(KEY);
    });
  });

  it("connect refuses fast without a key", async () => {
    await withApp({ COMPOSIO_API_KEY: "" }, async (app) => {
      const connect = await app.inject({ method: "POST", url: "/api/integrations/composio/connect" });
      expect(connect.statusCode).toBe(400);
      expect(connect.json<{ error: { code: string } }>().error.code).toBe("COMPOSIO_NOT_CONFIGURED");
      expect(connect.body).not.toContain(KEY);
    });
  });

  it("test-sheets needs a sheet id before any network", async () => {
    await withApp({ COMPOSIO_API_KEY: KEY, GOOGLE_SHEET_ID: "" }, async (app) => {
      const res = await app.inject({ method: "POST", url: "/api/setup/test-sheets", payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: false });
      expect(res.body).not.toContain(KEY);
    });
  });
});
