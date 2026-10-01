import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testContext } from "./helpers.js";

describe("sources", () => {
  it("lists registry entries with defaults when the table is empty", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/sources" });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ key: string; enabled: boolean; item_limit: number; requires: string[] }[]>();
        expect(body).toHaveLength(10);
        const hn = body.find((s) => s.key === "hackernews");
        expect(hn).toMatchObject({ enabled: true, item_limit: 50 });
        expect(hn?.requires).toEqual([]);
        const reddit = body.find((s) => s.key === "reddit");
        expect(Array.isArray(reddit?.requires)).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("PUT updates config and persists", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({
          method: "PUT",
          url: "/api/sources/reddit",
          payload: { enabled: false, item_limit: 25, config: { subreddits: ["ai"] } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<Record<string, unknown>>()).toMatchObject({
          key: "reddit",
          enabled: false,
          item_limit: 25,
          config: { subreddits: ["ai"] },
        });
        const list = await app.inject({ method: "GET", url: "/api/sources" });
        const reddit = list
          .json<{ key: string; enabled: boolean; item_limit: number }[]>()
          .find((s) => s.key === "reddit");
        expect(reddit).toMatchObject({ enabled: false, item_limit: 25 });
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("rejects unknown keys and bad bodies with VALIDATION", async () => {
    const t = testContext();
    try {
      const app = await buildApp(t.ctx);
      try {
        const unknown = await app.inject({
          method: "PUT",
          url: "/api/sources/nope",
          payload: { enabled: true },
        });
        expect(unknown.statusCode).toBe(400);
        for (const payload of [{ enabled: "yes" }, { item_limit: 0 }, { extra: 1 }]) {
          const res = await app.inject({
            method: "PUT",
            url: "/api/sources/rss",
            payload,
          });
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
});
