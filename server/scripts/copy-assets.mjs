// Copies non-TS runtime assets (SQL migrations) into dist/.
// tsc only emits JS + declarations, so this runs as the second build step.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "db", "migrations");
const to = join(root, "dist", "src", "db", "migrations");
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (f.endsWith(".sql")) copyFileSync(join(from, f), join(to, f));
}
process.stdout.write(`copy-assets: migrations → ${to}\n`);
