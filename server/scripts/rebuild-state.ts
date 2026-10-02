/**
 * rebuild-state — reconstruct seen_items from raw_trends when SQLite is
 * lost but the sheet survives (TRD §9). Reads every raw row, aggregates
 * first/last sightings per content_hash, and merges (never narrows).
 *
 * Usage: npm run rebuild-state [--dry-run]
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase } from "../src/db/sqlite.js";
import { applySeenRebuild, planSeenRebuild } from "../src/pipeline/rebuild.js";
import { SheetsRepo } from "../src/sheets/repo.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";
import { repoDbPath } from "./lib/dbPath.js";

loadEnvFiles();

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  if (config.googleSheetId === "") {
    process.stderr.write("rebuild-state: GOOGLE_SHEET_ID is not set.\n");
    process.exitCode = 1;
    return;
  }
  const dbPath = repoDbPath(import.meta.url);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyMigrations(db);
  try {
    const { client } = createRealSheetsClient(config.googleServiceAccountJsonPath);
    const repo = new SheetsRepo(client, {
      spreadsheetId: config.googleSheetId,
      cacheTtlS: config.sheetCacheTtlS,
    });
    const { rows, warnings } = await repo.readRaw();
    const plan = planSeenRebuild(rows);
    if (dryRun) {
      process.stdout.write(
        `rebuild-state: ${String(rows.length)} raw rows → ${String(plan.length)} hashes (dry run, ${String(warnings)} warnings).\n`,
      );
      return;
    }
    const { inserted, updated } = applySeenRebuild(db, plan);
    process.stdout.write(
      `rebuild-state: ${String(inserted)} inserted, ${String(updated)} merged, ${String(warnings)} warnings.\n`,
    );
  } finally {
    db.close();
  }
}

await main();
