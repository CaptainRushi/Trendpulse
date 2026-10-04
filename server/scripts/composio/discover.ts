/**
 * composio:discover (docs/15 PACKAGE C0) — list googlesheets tools and pin
 * them in integrations/composio/tools.lock.json.
 *
 * --check: validate the lock only (CI; needs no key) — exit 1 on a missing
 * or deprecated slug, or an unpinned version.
 * No key (or a rejected key): validate the existing lock and report WAITING;
 * never writes a lock it did not verify.
 */
import { loadEnvFiles } from "../../src/config/loadEnv.js";
import { loadConfig } from "../../src/config/env.js";
import { checkToolLock, loadToolLock } from "../../src/integrations/composio/tool-map.js";

loadEnvFiles();

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

if (checkOnly) {
  const problems = checkToolLock(loadToolLock());
  if (problems.length > 0) fail(`lock check FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.stdout.write("lock check ok — all ops mapped, version pinned.\n");
} else {
  const config = loadConfig();
  if (config.composioApiKey === "") {
    const problems = checkToolLock(loadToolLock());
    process.stdout.write(
      `WAITING: COMPOSIO_API_KEY not set — live discovery skipped.\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
    );
  } else {
    // Live tool-list shapes are unverified (docs/15 FACTS-5, key rejected in
    // this environment), so probe gently and never overwrite the lock on
    // any failure — report WAITING with the lock status instead.
    const probe = await fetch("https://backend.composio.dev/api/v3/tools/list", {
      method: "POST",
      headers: { "x-api-key": config.composioApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit_slugs: ["googlesheets"], limit: 500 }),
    }).then(
      (res) => ({ ok: res.ok, status: res.status, body: "" }),
      (error: unknown) => ({ ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }),
    );
    if (!probe.ok) {
      const problems = checkToolLock(loadToolLock());
      process.stdout.write(
        `WAITING: live discovery unreachable (status ${String(probe.status)}) — lock untouched.\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
      );
    } else {
      process.stdout.write("API reachable — full slug-mapping from live schema not yet implemented, lock untouched (see DECISIONS.md).\n");
    }
  }
}
