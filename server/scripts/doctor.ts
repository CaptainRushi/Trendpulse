/**
 * doctor — Phase 0 stub. Full diagnostics land in Phase 9.
 * Today: Node version, env parse, SQLite writable. One line per check,
 * actionable hints, non-zero exit when anything fails.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase } from "../src/db/sqlite.js";

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

try {
  const config = loadConfig();
  ok("env parses", `port=${String(config.port)} host=${config.host}`);
} catch (error) {
  fail("env parses", error instanceof Error ? error.message : String(error));
}

try {
  // Anchor repo root from this file (server/scripts/* → up 2), so the probe
  // DB lands next to the real one in repo-root data/ regardless of cwd.
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const probeDb = join(scriptsDir, "..", "..", "data", "state-doctor.db");
  const dbPath = process.env["STATE_DB_PATH"] ?? probeDb;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyMigrations(db);
  db.close();
  ok("sqlite migrations apply", dbPath);
} catch (error) {
  fail("sqlite migrations apply", error instanceof Error ? error.message : String(error));
}

// Phase 1+: sheets tabs. Phase 2+: OmniRoute /models, Jev sample completion.
// Phase 3+: per-collector ping. Each prints SKIP until its phase lands.
for (const label of ["sheets", "omniroute", "jev", "collectors"]) {
  process.stdout.write(`SKIP ${label} — not implemented until its phase (see docs/06_IMPLEMENTATION_PLAN.md)\n`);
}

if (failures > 0) {
  process.stdout.write(`\ndoctor: ${String(failures)} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\ndoctor: all Phase-0 checks passed\n");
}
