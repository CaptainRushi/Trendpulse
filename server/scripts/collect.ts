/**
 * collect — Phase 3 CLI: run collectors and print normalized draft items.
 *
 * Usage:
 *   npm run collect -- --source hackernews
 *   npm run collect -- --source hackernews --source wikipedia --limit 20
 *   npm run collect -- --all
 *
 * stdout: one JSON draft per line (pipeable).
 * stderr: run summary + per-source stats.
 * Exit code: 0 when no source errored, 1 otherwise (skips are not errors).
 *
 * Persistence: writes `runs` + `run_source_stats` (+ sources.last_*) so the
 * run is observable; item persistence lands in Phase 4 (raw_trends).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase, type StateDb } from "../src/db/sqlite.js";
import { COLLECTORS, runCollectors } from "../src/collectors/registry.js";
import type { SourceStats } from "../src/collectors/types.js";
import type { SourceKey } from "../src/sheets/schema.js";
import { ulid } from "../src/utils/ulid.js";
import { buildCollectContext } from "./lib/context.js";

dotenv.config();

const USAGE =
  "usage: npm run collect -- --source <key> [--source <key> ...] [--limit N]\n" +
  `       npm run collect -- --all [--limit N]\n` +
  `sources: ${Object.keys(COLLECTORS).join(", ")}\n`;

interface CliArgs {
  sources: SourceKey[];
  all: boolean;
  limit: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const sources: string[] = [];
  let all = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--source") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--source needs a value");
      sources.push(value);
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--limit needs a positive integer");
      limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!all && sources.length === 0) throw new Error("pass --source <key> (repeatable) or --all");
  if (all && sources.length > 0) throw new Error("--all and --source are mutually exclusive");
  for (const key of sources) {
    if (!(key in COLLECTORS)) throw new Error(`unknown source '${key}'`);
  }
  return { sources: sources as SourceKey[], all, limit };
}

interface SourceRow {
  key: string;
  enabled: number;
  item_limit: number;
  config_json: string;
}

function repoDbPath(): string {
  if (process.env["STATE_DB_PATH"] !== undefined && process.env["STATE_DB_PATH"] !== "") {
    return process.env["STATE_DB_PATH"];
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", "state.db");
}

function parseConfigJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadSourceRows(db: StateDb, keys: SourceKey[]): Map<string, SourceRow> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT key, enabled, item_limit, config_json FROM sources WHERE key IN (${placeholders})`)
    .all(...keys) as SourceRow[];
  return new Map(rows.map((row) => [row.key, row]));
}

function runStatus(stats: SourceStats[]): "success" | "partial" | "failed" {
  const errors = stats.filter((s) => s.status === "error").length;
  if (errors === 0) return "success";
  if (errors === stats.length) return "failed";
  return "partial";
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const dbPath = repoDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const rows = loadSourceRows(db, args.sources);
  // `--all` respects sources.enabled (missing row = enabled default);
  // an explicit --source always runs (manual override).
  const keys = args.all
    ? (Object.keys(COLLECTORS) as SourceKey[]).filter((key) => rows.get(key)?.enabled ?? true)
    : args.sources;
  if (keys.length === 0) {
    process.stderr.write("collect: no enabled sources\n");
    db.close();
    return;
  }

  const limits: Partial<Record<SourceKey, number>> = {};
  const configs: Partial<Record<SourceKey, Record<string, unknown>>> = {};
  for (const key of keys) {
    const row = rows.get(key);
    limits[key] = args.limit ?? row?.item_limit ?? config.maxItemsPerSource;
    configs[key] = row ? parseConfigJson(row.config_json) : {};
  }

  const runId = ulid();
  const startedAt = new Date().toISOString();
  const runDate = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  db.prepare(
    `INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at)
     VALUES (?, ?, 'manual', 'running', ?, ?)`,
  ).run(runId, runDate, JSON.stringify(["collect"]), startedAt);

  const ctx = buildCollectContext(runId, args.limit ?? config.maxItemsPerSource);
  const out = await runCollectors(ctx, { keys, limits, configs });

  const finishedAt = new Date().toISOString();
  const status = runStatus(out.stats);
  db.prepare(
    `UPDATE runs SET status = ?, finished_at = ?, items_collected = ? WHERE id = ?`,
  ).run(status, finishedAt, out.items.length, runId);

  const insertStats = db.prepare(
    `INSERT OR REPLACE INTO run_source_stats (run_id, source, status, items, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const touchSource = db.prepare(
    `UPDATE sources SET last_status = ?, last_error = ?, last_run_at = ?, last_items = ? WHERE key = ?`,
  );
  for (const stat of out.stats) {
    insertStats.run(runId, stat.source, stat.status, stat.items, stat.duration_ms, stat.error);
    // Row may not exist yet (sources seeded in Phase 6); no-op is fine.
    touchSource.run(stat.status, stat.error, finishedAt, stat.items, stat.source);
  }
  db.close();

  for (const item of out.items) {
    process.stdout.write(`${JSON.stringify(item)}\n`);
  }
  const duration = Date.now() - Date.parse(startedAt);
  for (const stat of out.stats) {
    const detail = stat.error ? ` — ${stat.error}` : "";
    process.stderr.write(
      `collect ${stat.source}: ${stat.status}, ${String(stat.items)} items in ${String(stat.duration_ms)}ms${detail}\n`,
    );
  }
  process.stderr.write(
    `collect: run ${runId} ${status}, ${String(out.items.length)} items in ${String(duration)}ms\n`,
  );
  if (out.stats.some((s) => s.status === "error")) process.exitCode = 1;
}

await main();
