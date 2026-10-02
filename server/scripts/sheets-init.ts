/**
 * sheets:init — create the four tabs (+ headers, frozen row 1) in the real sheet.
 * Needs GOOGLE_SHEET_ID and the service-account JSON key; otherwise prints
 * exactly what is missing and exits 1 (setup-friendly, no stack trace).
 */
import { existsSync } from "node:fs";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig } from "../src/config/env.js";
import { SheetsWriteQueue } from "../src/sheets/queue.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";
import { SheetsRepo } from "../src/sheets/repo.js";

loadEnvFiles();

const config = loadConfig();
const missing: string[] = [];
if (config.googleSheetId === "") missing.push("GOOGLE_SHEET_ID (share the sheet with the service-account email as Editor)");
if (!existsSync(config.googleServiceAccountJsonPath)) {
  missing.push(`service-account key not found at ${config.googleServiceAccountJsonPath}`);
}
if (missing.length > 0) {
  process.stdout.write("sheets:init skipped — missing:\n");
  for (const m of missing) process.stdout.write(`  - ${m}\n`);
  process.exit(1);
}

const bundle = createRealSheetsClient(config.googleServiceAccountJsonPath);
const repo = new SheetsRepo(bundle.client, {
  spreadsheetId: config.googleSheetId,
  cacheTtlS: config.sheetCacheTtlS,
  queue: new SheetsWriteQueue(),
});
const { created } = await repo.init();
const tabs = await bundle.client.getTabTitles(config.googleSheetId);
process.stdout.write(`service account: ${bundle.serviceAccountEmail}\n`);
process.stdout.write(`tabs: ${tabs.join(", ")}\n`);
process.stdout.write(
  created.length === 0 ? "already initialized (no tabs created)\n" : `created: ${created.join(", ")}\n`,
);
