/**
 * Interactive setup (Phase 9): walks server → sheets → OmniRoute → Jev →
 * collection → schedule, testing each connection live, then writes .env
 * (preserving comments and unknown keys). Secrets are tested, never
 * printed; clear scrollback after pasting keys on a shared screen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output, exit } from "node:process";
import { createInterface } from "node:readline/promises";
import cron from "node-cron";
import { loadServiceAccountKeyFile } from "../src/sheets/auth.js";
import { parseEnvText, upsertEnvLines } from "../src/config/envFile.js";
import { testJevConnection, testOmnirouteConnection } from "../src/llm/probe.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";

const repoRoot = join(dirname(new URL(".", import.meta.url).pathname), "..", "..");
const envPath = join(repoRoot, ".env");

const rl = createInterface({ input, output });

function ask(question: string, def = ""): Promise<string> {
  const suffix = def === "" ? ": " : ` [${def}]: `;
  return rl.question(`${question}${suffix}`).then((answer) => (answer.trim() === "" ? def : answer.trim()));
}

async function askSecret(question: string, isSet: boolean): Promise<string | null> {
  const suffix = isSet ? " (is set — type to replace, Enter to keep): " : ": ";
  const answer = (await rl.question(`${question}${suffix}`)).trim();
  return answer === "" ? null : answer;
}

async function askYesNo(question: string, def: boolean): Promise<boolean> {
  const hint = def ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
  if (answer === "") return def;
  return ["y", "yes", "1", "true"].includes(answer);
}

async function askInt(question: string, def: number, min: number): Promise<number> {
  for (;;) {
    const answer = await ask(question, String(def));
    const n = Number(answer);
    if (Number.isInteger(n) && n >= min) return n;
    output.write(`  Enter an integer >= ${String(min)}.\n`);
  }
}

function section(title: string): void {
  output.write(`\n== ${title} ==\n`);
}

async function main(): Promise<void> {
  if (!input.isTTY) {
    process.stderr.write("setup: needs an interactive terminal (stdin is not a TTY).\n");
    exit(1);
  }
  output.write("TrendPulse setup — values in [brackets] are the current ones, Enter keeps them.\n");

  const existing = existsSync(envPath) ? parseEnvText(readFileSync(envPath, "utf8")) : new Map<string, string>();
  const get = (key: string, fallback: string): string => existing.get(key) ?? fallback;
  const values = new Map<string, string>();

  // ── server ──
  section("Server");
  values.set("PORT", String(await askInt("Port", Number(get("PORT", "4317")), 1)));
  const host = await ask("Bind host (127.0.0.1 = localhost only)", get("HOST", "127.0.0.1"));
  values.set("HOST", host);
  values.set("TZ", await ask("Timezone (IANA, e.g. UTC or Europe/Berlin)", get("TZ", "UTC")));
  const passwordLoop = async (): Promise<string> => {
    const current = get("DASHBOARD_PASSWORD", "");
    const typed = await askSecret("Dashboard password (required for non-localhost binds)", current !== "");
    const password = typed ?? current;
    if (host.trim().toLowerCase() !== "127.0.0.1" && host.trim().toLowerCase() !== "localhost" && password === "") {
      output.write("  A password is required when binding a non-localhost address.\n");
      return passwordLoop();
    }
    return password;
  };
  values.set("DASHBOARD_PASSWORD", await passwordLoop());

  // ── sheets ──
  section("Google Sheets");
  output.write("  1. console.cloud.google.com → IAM & Admin → Service Accounts → Create.\n");
  output.write("  2. Keys → Add key → JSON, save the file.\n");
  output.write("  3. Share your sheet with the service-account email as Editor.\n");
  const keyPath = await ask(
    "Service-account JSON path",
    get("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", "./secrets/service-account.json"),
  );
  const resolvedKeyPath = join(repoRoot, keyPath);
  if (!existsSync(resolvedKeyPath)) {
    const paste = await askYesNo("Key file not found — paste the JSON now?", false);
    if (paste) {
      output.write("  Paste the JSON, then a line containing only END:\n");
      const lines: string[] = [];
      for (;;) {
        const line = await rl.question("");
        if (line.trim() === "END") break;
        lines.push(line);
      }
      try {
        const parsed: unknown = JSON.parse(lines.join("\n")) as unknown;
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("not a service-account key object");
        }
        const keyed = parsed as { client_email?: unknown; private_key?: unknown };
        if (typeof keyed.client_email !== "string" || typeof keyed.private_key !== "string") {
          throw new Error("not a service-account key object");
        }
        mkdirSync(dirname(resolvedKeyPath), { recursive: true });
        writeFileSync(resolvedKeyPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
        output.write(`  Saved to ${keyPath}.\n`);
      } catch (error) {
        output.write(`  Could not use that JSON (${error instanceof Error ? error.message : String(error)}). Continuing without it.\n`);
      }
    }
  }
  let serviceEmail = "";
  try {
    serviceEmail = loadServiceAccountKeyFile(resolvedKeyPath).clientEmail;
    output.write(`  Service account: ${serviceEmail}\n`);
  } catch {
    output.write("  Key file unreadable — sheets checks will fail until it exists.\n");
  }
  values.set("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", keyPath);
  const sheetId = await ask("Google Sheet ID (from the sheet URL)", get("GOOGLE_SHEET_ID", ""));
  values.set("GOOGLE_SHEET_ID", sheetId);
  if (sheetId !== "" && serviceEmail !== "") {
    try {
      const bundle = createRealSheetsClient(resolvedKeyPath);
      const tabs = await bundle.client.getTabTitles(sheetId);
      output.write(`  Sheet reachable — tabs: ${tabs.length === 0 ? "(empty)" : tabs.join(", ")}.\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`  Could not list tabs: ${message}\n`);
      if (/403|forbidden|permission/i.test(message) && serviceEmail !== "") {
        output.write(`  → Share the sheet with ${serviceEmail} as Editor, then continue.\n`);
      }
    }
  }

  // ── omniroute ──
  section("OmniRoute (page extraction)");
  const omniBase = await ask("Base URL", get("OMNIROUTE_BASE_URL", "http://localhost:20128/v1"));
  values.set("OMNIROUTE_BASE_URL", omniBase);
  const omniKey = (await askSecret("API key", get("OMNIROUTE_API_KEY", "") !== "")) ?? get("OMNIROUTE_API_KEY", "");
  values.set("OMNIROUTE_API_KEY", omniKey);
  let discoveredModels: string[] = [];
  try {
    const probe = await testOmnirouteConnection({ baseUrl: omniBase, apiKey: omniKey || undefined, timeoutMs: 15000 });
    if (probe.ok) {
      discoveredModels = probe.models;
      output.write(`  Reachable — models: ${probe.models.join(", ") || "(none listed)"}.\n`);
    } else {
      output.write(`  Probe failed: ${probe.error}\n`);
    }
  } catch (error) {
    output.write(`  Probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const extractDefault = get("OMNIROUTE_EXTRACT_MODEL", discoveredModels[0] ?? "");
  values.set("OMNIROUTE_EXTRACT_MODEL", await ask("Extract model id", extractDefault));

  // ── jev ──
  section("Jev (clustering + scoring)");
  output.write("  Leave the base URL empty to ride OmniRoute with the model id below.\n");
  const jevBase = await ask("Jev base URL (empty = via OmniRoute)", get("JEV_BASE_URL", ""));
  values.set("JEV_BASE_URL", jevBase);
  const jevKey = (await askSecret("Jev API key", get("JEV_API_KEY", "") !== "")) ?? get("JEV_API_KEY", "");
  values.set("JEV_API_KEY", jevKey);
  const jevModel = await ask("Jev model id", get("JEV_MODEL", "jev"));
  values.set("JEV_MODEL", jevModel);
  try {
    const probe = await testJevConnection({
      baseUrl: jevBase,
      apiKey: jevKey || undefined,
      model: jevModel,
      fallback: { baseUrl: omniBase, apiKey: omniKey },
      timeoutMs: 30000,
    });
    output.write(probe.ok ? `  Jev sample OK (${probe.model}).\n` : `  Jev probe failed: ${probe.error}\n`);
  } catch (error) {
    output.write(`  Jev probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // ── collection + schedule ──
  section("Collection");
  values.set("TRENDS_GEO", await ask("Trends region", get("TRENDS_GEO", "US")));
  values.set("NICHES", await ask("Niches, comma-separated (empty = general interest)", get("NICHES", "")));
  values.set("MAX_ITEMS_PER_SOURCE", String(await askInt("Max items per source", Number(get("MAX_ITEMS_PER_SOURCE", "50")), 1)));
  values.set("DEDUPE_DAYS", String(await askInt("Cross-day dedupe window (days)", Number(get("DEDUPE_DAYS", "3")), 0)));
  values.set("SORT_BATCH_SIZE", String(await askInt("Sort batch size", Number(get("SORT_BATCH_SIZE", "30")), 1)));
  values.set("TOP_N", String(await askInt("Top N topics", Number(get("TOP_N", "50")), 1)));
  values.set("RETENTION_DAYS", String(await askInt("Sheet retention (days)", Number(get("RETENTION_DAYS", "30")), 1)));
  const retentionMode = await ask("Retention mode (archive/delete)", get("RETENTION_MODE", "archive"));
  values.set("RETENTION_MODE", retentionMode === "delete" ? "delete" : "archive");

  section("Schedule");
  for (;;) {
    const cronExpr = await ask("Daily cron (5-field)", get("SCHEDULE_CRON", "0 6 * * *"));
    if (cron.validate(cronExpr)) {
      values.set("SCHEDULE_CRON", cronExpr);
      break;
    }
    output.write('  Not a valid 5-field cron expression (e.g. "0 6 * * *").\n');
  }
  values.set("RUN_MISSED_ON_START", (await askYesNo("Catch up missed runs on boot?", get("RUN_MISSED_ON_START", "true") !== "false")) ? "true" : "false");

  // ── optional source keys ──
  section("Optional source keys (Enter to skip)");
  for (const key of ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "GITHUB_TOKEN", "YOUTUBE_API_KEY", "PRODUCTHUNT_TOKEN"]) {
    const current = get(key, "");
    const typed = await askSecret(key, current !== "");
    values.set(key, typed ?? current);
  }

  const existingLines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  writeFileSync(envPath, `${upsertEnvLines(existingLines, values).join("\n").replace(/\n+$/, "")}\n`);
  output.write(`\nWrote ${envPath} (${String(values.size)} keys).\n`);
  output.write("Next: npm run dev, open http://localhost:4317, and finish the web wizard.\n");
  output.write("Run npm run doctor anytime to re-check every connection.\n");
  rl.close();
}

await main();
