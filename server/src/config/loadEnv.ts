/**
 * Entry-point dotenv loading. Workspace scripts run with cwd=server/, so a
 * bare dotenv.config() never sees the repo-root .env — load both (cwd first,
 * then root). Machine env always wins: dotenv never overrides.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export function loadEnvFiles(): void {
  dotenv.config();
  const rootEnv = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
  if (existsSync(rootEnv)) dotenv.config({ path: rootEnv });
}
