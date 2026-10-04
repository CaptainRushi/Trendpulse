/**
 * sheets:init — create the four tabs (+ headers, frozen row 1) in the real sheet.
 * Needs GOOGLE_SHEET_ID and the service-account JSON key; otherwise prints
 * exactly what is missing and exits 1 (setup-friendly, no stack trace).
 */
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig } from "../src/config/env.js";
import { SheetsWriteQueue } from "../src/sheets/queue.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";
import { SheetsRepo } from "../src/sheets/repo.js";

loadEnvFiles();

const config = loadConfig();
const sheetId = config.googleSheetId;

if (sheetId === "") {
  process.stdout.write("sheets:init skipped — missing:\n  - GOOGLE_SHEET_ID\n");
  process.exit(1);
}
let bundle;
try {
  bundle = createRealSheetsClient(config.googleServiceAccountJsonPath);
} catch {
  process.stdout.write("sheets:init skipped — missing:\n  - service-account key file\n");
  process.exit(1);
}
const client = bundle.client;
const authLabel = bundle.serviceAccountEmail;

const repo = new SheetsRepo(client, {
  spreadsheetId: sheetId,
  cacheTtlS: config.sheetCacheTtlS,
  queue: new SheetsWriteQueue(),
});
const { created } = await repo.init();
const tabs = await client.getTabTitles(sheetId);
process.stdout.write(`auth: ${authLabel}\n`);
process.stdout.write(`tabs: ${tabs.join(", ")}\n`);
process.stdout.write(
  created.length === 0 ? "already initialized (no tabs created)\n" : `created: ${created.join(", ")}\n`,
);
