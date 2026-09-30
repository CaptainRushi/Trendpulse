/**
 * doctor — Phase 0 checks + Phase 3 per-collector ping. Full diagnostics
 * land in Phase 9. One line per check, actionable hints, non-zero exit when
 * a hard check fails (pings only WARN — unconfigured sources are not doctor
 * failures).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig, type TrendPulseConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase, type StateDb } from "../src/db/sqlite.js";
import { COLLECTORS, pingSource } from "../src/collectors/registry.js";
import type { SourceKey } from "../src/sheets/schema.js";
import { buildCollectContext } from "./lib/context.js";

dotenv.config();

let failures = 0;

function ok(label: string, detail = ""): void {
  process.stdout.write(`ok   ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function fail(label: string, hint: string): void {
  failures += 1;
  process.stdout.write(`FAIL ${label}\n     → ${hint}\n`);
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

// Phase 1+: sheets tabs. Phase 2+: OmniRoute /models, Jev sample completion.
for (const label of ["sheets", "omniroute", "jev"]) {
  process.stdout.write(`SKIP ${label} — not implemented until its phase (see docs/06_IMPLEMENTATION_PLAN.md)\n`);
}
db?.close();

if (failures > 0) {
  process.stdout.write(`\ndoctor: ${String(failures)} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\ndoctor: all Phase-0 checks passed\n");
}
