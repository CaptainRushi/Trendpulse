/**
 * doctor — full diagnostics (Phase 9): node, env, sqlite, sheets tabs,
 * OmniRoute models, Jev sample, per-collector pings. One line per check
 * with actionable hints; non-zero exit when a hard check fails. WARN =
 * not configured (run setup); FAIL = configured but broken.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig, resolveJevEndpoint, type TrendPulseConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase, type StateDb } from "../src/db/sqlite.js";
import { COLLECTORS, pingSource } from "../src/collectors/registry.js";
import type { SourceKey } from "../src/sheets/schema.js";
import { testJevConnection, testOmnirouteConnection } from "../src/llm/probe.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";
import { ComposioSheetsClient } from "../src/sheets/composioClient.js";
import { buildCollectContext } from "./lib/context.js";

loadEnvFiles();

let failures = 0;

function ok(label: string, detail = ""): void {
  process.stdout.write(`ok   ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function fail(label: string, hint: string): void {
  failures += 1;
  process.stdout.write(`FAIL ${label}\n     → ${hint}\n`);
}

function warn(label: string, hint: string): void {
  process.stdout.write(`WARN ${label}\n     → ${hint}\n`);
}

const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 20) {
  fail(`node version (${process.versions.node})`, "Install Node.js 20 or newer: https://nodejs.org/");
} else {
  ok(`node version (${process.versions.node})`);
}

let config: TrendPulseConfig | undefined;
try {
  config = loadConfig();
  ok("env parses", `port=${String(config.port)} host=${config.host}`);
} catch (error) {
  fail("env parses", error instanceof Error ? error.message : String(error));
}

let db: StateDb | undefined;
try {
  // Anchor repo root from this file (server/scripts/* → up 2), so the probe
  // DB lands next to the real one in repo-root data/ regardless of cwd.
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const probeDb = join(scriptsDir, "..", "..", "data", "state-doctor.db");
  const dbPath = process.env["STATE_DB_PATH"] ?? probeDb;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = openDatabase(dbPath);
  applyMigrations(db);
  ok("sqlite migrations apply", dbPath);
} catch (error) {
  fail("sqlite migrations apply", error instanceof Error ? error.message : String(error));
}

// Phase 3: per-collector ping — one cheap request each; never throws.
// WARN (not FAIL) so an unconfigured source doesn't fail the whole doctor.
if (config !== undefined && db !== undefined) {
  try {
    const ctx = buildCollectContext("run_doctor", 1);
    for (const key of Object.keys(COLLECTORS) as SourceKey[]) {
      const row = db
        .prepare("SELECT config_json FROM sources WHERE key = ?")
        .get(key) as { config_json: string } | undefined;
      const sourceConfig = row ? (JSON.parse(row.config_json) as Record<string, unknown>) : {};
      const result = await pingSource(key, ctx, sourceConfig);
      const label = `ping ${key}`;
      if (result.ok) {
        ok(label, result.detail);
      } else {
        process.stdout.write(`WARN ${label}\n     → ${result.detail}\n`);
      }
    }
  } catch (error) {
    fail("collector pings", error instanceof Error ? error.message : String(error));
  }
} else {
  process.stdout.write("SKIP collectors — env or sqlite unavailable\n");
}

// Sheets: tabs reachable through the real client. Missing id/key file is
// "not configured" (WARN); anything else is FAIL with a fix hint.
if (config !== undefined) {
  const sheetId = config.googleSheetId;
  if (sheetId === "") {
    warn("sheets tabs", "GOOGLE_SHEET_ID not set — run npm run setup.");
  } else {
    try {
      const client = config.composioApiKey !== ""
        ? new ComposioSheetsClient(config.composioApiKey)
        : createRealSheetsClient(config.googleServiceAccountJsonPath).client;
      const tabs = await client.getTabTitles(sheetId);
      const authLabel = config.composioApiKey !== "" ? "composio" : "service-account";
      ok("sheets tabs", `${String(tabs.length)} tabs via ${authLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/403|forbidden|permission/i.test(message)) {
        fail("sheets tabs", `${message} → check Composio connection or share the sheet with the service-account email as Editor.`);
      } else {
        fail("sheets tabs", message);
      }
    }
  }
} else {
  process.stdout.write("SKIP sheets — env unavailable\n");
}

// OmniRoute: no key = degraded extraction (WARN); a keyed but dead
// gateway is FAIL.
if (config !== undefined) {
  if (config.omnirouteApiKey === "") {
    warn("omniroute /models", "OMNIROUTE_API_KEY not set — page extraction degraded.");
  } else {
    try {
      const probe = await testOmnirouteConnection({
        baseUrl: config.omnirouteBaseUrl,
        apiKey: config.omnirouteApiKey,
        timeoutMs: 45000,
      });
      if (probe.ok) ok("omniroute /models", `${String(probe.models.length)} models`);
      else fail("omniroute /models", probe.error);
    } catch (error) {
      fail("omniroute /models", error instanceof Error ? error.message : String(error));
    }
  }
} else {
  process.stdout.write("SKIP omniroute — env unavailable\n");
}

// Jev: always probed with a sample completion (sorting cannot run blind).
// Anything but ok is FAIL — a silent sorter helps nobody.
if (config !== undefined) {
  const endpoint = resolveJevEndpoint(config);
  if (config.jevModel.trim() === "") {
    warn("jev sample", "JEV_MODEL empty — set a model id, then re-run doctor.");
  } else {
    try {
      const probe = await testJevConnection({
        baseUrl: config.jevBaseUrl,
        path: config.jevPath,
        apiKey: config.jevApiKey || undefined,
        model: config.jevModel,
        fallback: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
        timeoutMs: 30000,
      });
      if (probe.ok) ok("jev sample", `${probe.model} answered`);
      else fail("jev sample", probe.error);
    } catch (error) {
      fail("jev sample", error instanceof Error ? error.message : String(error));
    }
  }
} else {
  process.stdout.write("SKIP jev — env unavailable\n");
}
db?.close();

if (failures > 0) {
  process.stdout.write(`\ndoctor: ${String(failures)} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\ndoctor: all checks passed\n");
}
