import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import { budgetUsage, recordCall, usageBySlug } from "../../src/integrations/composio/budget.js";
import { preflightComposio } from "../../src/integrations/composio/auth.js";
import { loadToolLock } from "../../src/integrations/composio/tool-map.js";

const PINNED = { ...loadToolLock(), version: "20260817_00" };

function freshDb() {
  const db = openDatabase(":memory:");
  applyMigrations(db);
  return db;
}

describe("CMP-10 monthly call budget", () => {
  it("counts this month's calls, warns at 80%, blocks at 100%", () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) {
      recordCall(db, "run_1", { slug: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", ok: true, latencyMs: 900 });
    }
    const warm = budgetUsage(db, 10);
    expect(warm.used).toBe(8);
    expect(warm.warning).toBe(true);
    expect(warm.exhausted).toBe(false);
    expect(preflightComposio({ apiKey: "k", sheetId: "s", lock: PINNED, budgetUsed: warm.used, budgetLimit: 10, connectionStatus: "ACTIVE" }).warnings).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      recordCall(db, "run_1", { slug: "GOOGLESHEETS_BATCH_GET", ok: false, latencyMs: 1200 });
    }
    const broke = budgetUsage(db, 10);
    expect(broke.exhausted).toBe(true);
    expect(
      preflightComposio({ apiKey: "k", sheetId: "s", lock: PINNED, budgetUsed: broke.used, budgetLimit: 10, connectionStatus: "ACTIVE" }).blockers,
    ).toContain("COMPOSIO_BUDGET_EXCEEDED");
    expect(usageBySlug(db)).toEqual([
      { slug: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", status: "ok", calls: 8 },
      { slug: "GOOGLESHEETS_BATCH_GET", status: "error", calls: 2 },
    ]);
    db.close();
  });

  it("no limit means never exhausted, never warns", () => {
    const db = freshDb();
    recordCall(db, undefined, { slug: "X", ok: true, latencyMs: 1 });
    const usage = budgetUsage(db, 0);
    expect(usage.exhausted).toBe(false);
    expect(usage.warning).toBe(false);
    db.close();
  });

  it("old calls from previous months do not count", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO integration_calls (provider, slug, status, latency_ms, created_at) VALUES ('composio','X','ok',1,?)",
    ).run("2020-01-15 00:00:00");
    expect(budgetUsage(db, 10).used).toBe(0);
    db.close();
  });
});
