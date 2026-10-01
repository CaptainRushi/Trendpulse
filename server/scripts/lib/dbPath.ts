/** Shared repo-root data/state.db resolution (STATE_DB_PATH wins). */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repoDbPath(fromFile: string): string {
  if (process.env["STATE_DB_PATH"] !== undefined && process.env["STATE_DB_PATH"] !== "") {
    return process.env["STATE_DB_PATH"];
  }
  const here = dirname(fileURLToPath(fromFile));
  return join(here, "..", "..", "data", "state.db");
}
