import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { testContext } from "./helpers.js";

describe("sheets admin", () => {
  it("init is idempotent, sync ok, link has the spreadsheet url", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const first = await app.inject({ method: "POST", url: "/api/sheets/init" });
        expect(first.json<{ created: string[] }>().created).toHaveLength(4);
        const second = await app.inject({ method: "POST", url: "/api/sheets/init" });
        expect(second.json<{ created: string[] }>().created).toEqual([]);

        const sync = await app.inject({ method: "POST", url: "/api/sheets/sync" });
        expect(sync.json<{ ok: boolean }>().ok).toBe(true);

        const link = await app.inject({ method: "GET", url: "/api/sheets/link" });
        const body = link.json<{ spreadsheet_url: string; tabs: Record<string, string> }>();
        expect(body.spreadsheet_url).toBe("https://docs.google.com/spreadsheets/d/test-sheet");
        expect(body.tabs["raw_trends"]).toBe(body.spreadsheet_url);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("requires a configured sheet id (SETUP_INCOMPLETE)", async () => {
    const t = testContext({ config: loadConfig({}) });
    try {
      const app = await buildApp(t.ctx);
      try {
        for (const [method, url] of [
          ["POST", "/api/sheets/init"],
          ["POST", "/api/sheets/sync"],
          ["GET", "/api/sheets/link"],
        ] as const) {
          const res = await app.inject({ method, url });
          expect(res.statusCode).toBe(400);
          expect(res.json<{ error: { code: string } }>().error.code).toBe("SETUP_INCOMPLETE");
        }
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});

describe("password gate", () => {
  it("401s without the password, passes with it, open when unset", async () => {
    const locked = testContext({ config: loadConfig({ DASHBOARD_PASSWORD: "s3cret" }) });
    try {
      const app = await buildApp(locked.ctx);
      try {
        const anon = await app.inject({ method: "GET", url: "/api/health" });
        expect(anon.statusCode).toBe(401);
        expect(anon.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
        expect(anon.headers["www-authenticate"]).toContain("Basic");

        const wrong = await app.inject({
          method: "GET",
          url: "/api/health",
          headers: { authorization: `Basic ${Buffer.from("u:wrong").toString("base64")}` },
        });
        expect(wrong.statusCode).toBe(401);

        const right = await app.inject({
          method: "GET",
          url: "/api/health",
          headers: { authorization: `Basic ${Buffer.from("u:s3cret").toString("base64")}` },
        });
        expect(right.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    } finally {
      await locked.close();
    }
  });
});
