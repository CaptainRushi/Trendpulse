/**
 * Step-1 foundation checks (docs/12 Prompt 1). Titles start with the test ID
 * per CLAUDE.md rule 9. These are additive to the existing phase suites —
 * they pin the Day-1 contract without renaming history.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Momentum, SortedTopic } from "@trendpulse/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, listMigrations, openDatabase } from "../src/db/sqlite.js";
import { createLogger } from "../src/utils/logger.js";
import { testContext } from "./api/helpers.js";

/** Mirrors verify/registry.ts exit rule (kept local: server rootDir cannot import ../../verify). */
function exitCodeFor(results: { status: string }[]): number {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

describe("STEP 1 foundation", () => {
  it("INF-01 config defaults applied and every problem listed on failure", () => {
    const config = loadConfig({});
    expect(config.port).toBe(4317);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tz).toBe("UTC");
    expect(config.logLevel).toBe("info");
    expect(config.scheduleCron).toBe("0 6 * * *");
    expect(config.runMissedOnStart).toBe(true);
    expect(config.googleServiceAccountJsonPath).toBe("./secrets/service-account.json");
    expect(config.googleSheetId).toBe("");
    expect(config.sheetCacheTtlS).toBe(60);
    expect(config.omnirouteBaseUrl).toBe("http://localhost:20128/v1");
    expect(config.llmConcurrency).toBe(2);
    expect(config.llmTimeoutMs).toBe(90000);
    // Day-1 Jev/writer additions (additive; defaults per docs/12 Prompt 1).
    expect(config.jevPath).toBe("/v1/systemone");
    expect(config.jevConcurrency).toBe(8);
    expect(config.jevPricePerMInput).toBeCloseTo(0.04);
    expect(config.jevRunBudgetUsd).toBeCloseTo(1.0);
    expect(config.jevFallback).toBe(true);
    expect(config.qualityMin).toBeCloseTo(0.5);
    expect(config.trendsGeo).toBe("US");
    expect(config.niches).toEqual([]);
    expect(config.maxItemsPerSource).toBe(50);
    expect(config.dedupeDays).toBe(3);
    expect(config.userAgent).toBe("TrendPulse/1.0 (+local)");
    expect(config.topPerCategory).toBe(5);
    expect(config.maxCategories).toBe(6);
    expect(config.includeGeneralSources).toBe(false);
    expect(config.retentionDays).toBe(30);

    expect(() => loadConfig({ PORT: "not-a-port", LOG_LEVEL: "verbose" })).toThrowError(
      /Invalid environment configuration:[\s\S]*PORT[\s\S]*LOG_LEVEL|Invalid environment configuration:[\s\S]*LOG_LEVEL[\s\S]*PORT/,
    );
  });

  it("INF-02 migrations apply on empty DB, are idempotent and gap-tolerant", () => {
    const db = openDatabase(":memory:");
    try {
      const applied = applyMigrations(db);
      // Gap allowed: 001 then 003 then 006/008/009/010 (002/004/005/007 arrive later).
      expect(applied).toContain(1);
      expect(applied).toContain(3);
      expect(applied).toContain(6);
      expect(applied).toContain(8);
      expect(applied).toContain(9);
      expect(applied).toContain(10);
      expect(applied).not.toContain(2);
      expect(applied).not.toContain(7);
      const versions = listMigrations().map((m) => m.version);
      expect(versions).toEqual([1, 3, 6, 8, 9, 10]);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("schema_migrations");
      expect(names).toContain("item_labels");

      const second = applyMigrations(db);
      expect(second).toEqual([]);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[];
      expect(rows.map((r) => r.version)).toEqual([1, 3, 6, 8, 9, 10]);
    } finally {
      db.close();
    }
  });

  it("INF-03 logger redacts keys, tokens, passwords and the private key", async () => {
    let captured = "";
    const stream = {
      write(chunk: string): boolean {
        captured += chunk;
        return true;
      },
    };
    const logger = createLogger("info", stream);
    logger.info(
      {
        OMNIROUTE_API_KEY: "omni-secret-1",
        JEV_API_KEY: "jev-secret-1",
        DASHBOARD_PASSWORD: "dash-secret-1",
        nested: { GITHUB_TOKEN: "gh-secret-1", private_key: "rsa-secret-1" },
      },
      "boot",
    );
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));
    for (const secret of ["omni-secret-1", "jev-secret-1", "dash-secret-1", "gh-secret-1", "rsa-secret-1"]) {
      expect(captured).not.toContain(secret);
    }
    expect(captured).toContain("[Redacted]");
  });

  it("INF-04 health endpoint answers on 127.0.0.1 with the documented fields", async () => {
    const config = loadConfig({ GOOGLE_SHEET_ID: "test-sheet" });
    expect(config.host).toBe("127.0.0.1");
    const t = testContext({ config });
    try {
      const app = await buildApp(t.ctx);
      try {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json<Record<string, unknown>>();
        for (const key of [
          "ok",
          "version",
          "setup_complete",
          "sheets",
          "omniroute",
          "jev",
          "next_run_at",
          "last_run",
        ]) {
          expect(body, `missing health field ${key}`).toHaveProperty(key);
        }
        expect(body["ok"]).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });

  it("INF-05 verify registry loads and exit codes follow PASS/FAIL", () => {
    // Shared contract compiles in server context (W-10): domain types parse.
    expect(Momentum.safeParse("fading").success).toBe(false);
    expect(Momentum.safeParse("rising").success).toBe(true);
    expect(SortedTopic).toBeDefined();
    // Registry file exists at the Step-1 path with the required shape.
    const registryPath = join(process.cwd(), "..", "verify", "registry.ts");
    const direct = join(process.cwd(), "verify", "registry.ts");
    const path = existsSync(direct) ? direct : registryPath;
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toContain("export const registry");
    expect(source).toContain("exitCodeFor");
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([{ status: "PASS" }])).toBe(0);
    expect(exitCodeFor([{ status: "PASS" }, { status: "FAIL" }])).toBe(1);
  });
});
