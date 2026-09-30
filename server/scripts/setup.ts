/**
 * setup — Phase 0 stub. The interactive wizard CLI lands in Phase 9.
 * Today: verifies .env exists (or copies .env.example) and exits.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");
const envPath = join(repoRoot, ".env");
const examplePath = join(repoRoot, ".env.example");

if (!existsSync(envPath) && existsSync(examplePath)) {
  copyFileSync(examplePath, envPath);
  process.stdout.write("setup: created .env from .env.example — edit it, then re-run setup.\n");
} else if (existsSync(envPath)) {
  process.stdout.write("setup: .env already exists — full interactive setup lands in Phase 9.\n");
} else {
  process.stdout.write("setup: .env.example not found — are you in the repo root?\n");
  process.exitCode = 1;
}
