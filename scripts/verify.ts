#!/usr/bin/env tsx
/**
 * Day-1 health board (docs/12 §8): the 23 rows in verify/registry.ts.
 * Fake mode runs each row's named vitest tests against fakes.
 * `--mode live` probes real services where credentials exist and marks
 * the rest SKIPPED. Exit 1 on any FAIL. Writes verify-report.json.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "../server/src/config/loadEnv.js";
import { registry, exitCodeFor, type BoardRow, type LiveProbe, type VerifyResult } from "../verify/registry.js";

const args = process.argv.slice(2);
const mode: "fake" | "live" =
  args.includes("--mode=live") ||
  (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "live") ||
  args.includes("live")
    ? "live"
    : "fake";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runVitest(ws: "server" | "web", files: string[], pattern: string): Promise<{ ok: boolean; output: string }> {
  // ponytail: .cmd shims need a shell on Windows; one string, no interpolation.
  const cmd = `npx vitest run ${files.join(" ")} -t "${pattern}"`;
  return new Promise((resolve) => {
    execFile(
      cmd,
      { cwd: join(ROOT, ws), timeout: 180000, shell: true, windowsHide: true } as object,
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: String(stdout ?? "") + String(stderr ?? "") });
      },
    );
  });
}

/** Run one row's fake groups; returns failed group outputs (empty = pass). */
async function runFakeGroups(row: BoardRow): Promise<string[]> {
  const failures: string[] = [];
  for (const group of row.fake) {
    const result = await runVitest(group.ws, group.files, group.pattern);
    if (!result.ok) {
      const tail = result.output.trim().split("\n").slice(-15).join("\n");
      failures.push(`${group.ws} ${group.files.join(",")} -t ${group.pattern}\n${tail}`);
    }
  }
  return failures;
}

type Part = { status: "PASS" | "FAIL" | "SKIP"; detail?: string };

function timeout<T>(ms: number, reason: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([fn(), gate]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function runProbe(probe: LiveProbe): Promise<Part> {
  const { loadConfig, resolveJevEndpoint } = await import("../server/src/config/env.js");
  if (probe.kind === "sheets-tabs") {
    const config = loadConfig();
    if (config.googleSheetId === "") return { status: "SKIP", detail: "GOOGLE_SHEET_ID not set" };
    try {
      const { resolveSheetsClient } = await import("../server/src/sheets/resolve.js");
      const client = resolveSheetsClient(config).client;
      const tabs = await timeout(25000, "sheets timed out", () => client.getTabTitles(config.googleSheetId));
      return tabs.length >= 4
        ? { status: "PASS", detail: `${tabs.length} tabs` }
        : { status: "FAIL", detail: `only ${tabs.length} tabs` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return /not found|ENOENT|no such file/i.test(msg)
        ? { status: "SKIP", detail: "service-account key file missing" }
        : { status: "FAIL", detail: msg };
    }
  }
  if (probe.kind === "ping") {
    try {
      const { buildCollectContext } = await import("../server/scripts/lib/context.js");
      const { pingSource } = await import("../server/src/collectors/registry.js");
      const ctx = buildCollectContext("verify_live", 3);
      const result = await timeout(25000, "ping timed out", () => pingSource(probe.source, ctx, {}));
      if (result.ok) return { status: "PASS", detail: result.detail };
      return /blocked|403|429|no ping|no feed|not configured|missing|empty|unconfigured/i.test(result.detail)
        ? { status: "SKIP", detail: result.detail }
        : { status: "FAIL", detail: result.detail };
    } catch (error) {
      return { status: "SKIP", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (probe.kind === "jev-sample") {
    const config = loadConfig();
    if (config.jevModel.trim() === "" || (config.jevApiKey === "" && config.omnirouteApiKey === "")) {
      return { status: "SKIP", detail: "no Jev key/model configured" };
    }
    try {
      const { testJevConnection } = await import("../server/src/llm/probe.js");
      const endpoint = resolveJevEndpoint(config);
      const probe2 = await timeout(
        45000,
        "jev sample timed out",
        () => testJevConnection({
          baseUrl: config.jevBaseUrl,
          path: config.jevPath,
          apiKey: config.jevApiKey || undefined,
          model: config.jevModel,
          fallback: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
          timeoutMs: 30000,
        }),
      );
      return probe2.ok ? { status: "PASS", detail: `${probe2.model} answered` } : { status: "FAIL", detail: probe2.error };
    } catch (error) {
      return { status: "FAIL", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  // connection-probes: each configured service, SKIP when unconfigured
  const config = loadConfig();
  const parts: Part[] = [];
  parts.push(await runProbe({ kind: "sheets-tabs" }));
  if (config.omnirouteApiKey === "") {
    parts.push({ status: "SKIP", detail: "OMNIROUTE_API_KEY not set" });
  } else {
    try {
      const { testOmnirouteConnection } = await import("../server/src/llm/probe.js");
      const probe2 = await timeout(25000, "omniroute timed out", () => testOmnirouteConnection({
        baseUrl: config.omnirouteBaseUrl, apiKey: config.omnirouteApiKey, timeoutMs: 15000,
      }));
      parts.push(probe2.ok ? { status: "PASS", detail: `${probe2.models.length} models` } : { status: "FAIL", detail: probe2.error });
    } catch (error) {
      parts.push({ status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  parts.push(await runProbe({ kind: "jev-sample" }));
  if (parts.some((p) => p.status === "FAIL")) {
    return { status: "FAIL", detail: parts.filter((p) => p.status === "FAIL").map((p) => p.detail).join("; ") };
  }
  const ran = parts.filter((p) => p.status === "PASS");
  return ran.length > 0
    ? { status: "PASS", detail: ran.map((p) => p.detail).join("; ") }
    : { status: "SKIP", detail: "no services configured" };
}

async function main(): Promise<void> {
  if (mode === "live") loadEnvFiles();
  console.log(`TrendPulse verify (mode: ${mode})`);
  console.log(`${registry.length} checks\n`);

  const results: VerifyResult[] = [];
  for (const row of registry) {
    const t0 = performance.now();
    const details: string[] = [];
    let failed = false;
    let ran = false;
    const runFake = mode === "fake" || row.local === true;
    if (runFake) {
      ran = true;
      const failures = await runFakeGroups(row);
      if (failures.length > 0) {
        failed = true;
        details.push(failures.join("\n"));
      }
    }
    if (mode === "live" && row.live) {
      for (const probe of row.live) {
        const part = await runProbe(probe);
        if (part.status !== "SKIP") ran = true;
        if (part.status === "FAIL") failed = true;
        if (part.detail) details.push(`${probe.kind === "ping" ? `ping ${probe.source}` : probe.kind}: ${part.status} — ${part.detail}`);
      }
    }
    if (mode === "live" && row.note) details.push(row.note);
    const status = failed ? "FAIL" : ran ? "PASS" : "SKIP";
    results.push({ id: row.id, status, ms: Math.round(performance.now() - t0), detail: details.join("\n") || undefined });
    const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "○";
    console.log(` ${mark} ${row.id} ${row.feature}${status === "SKIP" && details[0] ? ` — ${details[0].split("\n")[0]}` : ""}`);
    const failedDetail = results[results.length - 1];
    if (status === "FAIL" && failedDetail?.detail) console.log(failedDetail.detail);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${pass} pass · ${fail} fail · ${skip} skip`);

  writeFileSync(join(ROOT, "verify-report.json"), JSON.stringify(results, null, 2));
  process.exitCode = exitCodeFor(results);
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
