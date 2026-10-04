/**
 * tools.lock.json loader + validator (docs/15 PACKAGE C0).
 * Pure: no network, no env. The lock pins the dated toolkit version and the
 * logical-op → slug map so a Composio rename/deprecation fails loudly in CI
 * (`composio:discover --check`) instead of breaking the pipeline at 6am.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ComposioError } from "./errors.js";

/** Slugs Composio deprecated — must never appear in the lock. */
export const DEPRECATED_SLUGS: readonly string[] = [
  "GOOGLESHEETS_BATCH_UPDATE",
  "GOOGLESHEETS_SHEET_FROM_JSON",
  "GOOGLESHEETS_LIST_TABLES",
];

/** Logical ops the SheetsClient needs. formatHeader is cosmetic (optional). */
export const REQUIRED_OPS: readonly string[] = [
  "createSpreadsheet",
  "spreadsheetInfo",
  "addSheet",
  "writeRange",
  "appendRows",
  "readRanges",
  "updateRanges",
  "deleteRows",
];

export interface ToolLockOp {
  slug: string;
  params: string[];
  optional?: boolean;
  /** Logical arg name → the tool's real arg name (applied before every call). */
  rename?: Record<string, string>;
  /** Constant args the tool requires (applied only when the caller omitted them). */
  defaults?: Record<string, unknown>;
}

export interface ToolLock {
  toolkit: string;
  version: string;
  generated_at: string;
  note?: string;
  ops: Record<string, ToolLockOp>;
}

export function lockPath(): string {
  return fileURLToPath(new URL("./tools.lock.json", import.meta.url));
}

export function loadToolLock(path: string = lockPath()): ToolLock {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ComposioError("COMPOSIO_TOOL_MISSING", `tool lock not found at '${path}' — run npm run composio:discover.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ComposioError("COMPOSIO_TOOL_MISSING", `tool lock at '${path}' is not valid JSON — re-run npm run composio:discover.`);
  }
  return parsed as ToolLock;
}

/** Version is pinned only when dated (never UNPINNED, latest, or base 00000000_00). */
export function isPinnedVersion(version: unknown): boolean {
  return (
    typeof version === "string" &&
    version !== "" &&
    version !== "UNPINNED" &&
    version.toLowerCase() !== "latest" &&
    version !== "00000000_00"
  );
}

/** All reasons this lock must not be used for execution. Empty = usable. */
export function checkToolLock(lock: ToolLock): string[] {
  const problems: string[] = [];
  if (!isPinnedVersion(lock.version)) {
    problems.push(
      `toolkit version '${lock.version}' is not pinned — set a valid COMPOSIO_API_KEY, then run npm run composio:discover.`,
    );
  }
  const ops: Record<string, ToolLockOp | undefined> = lock.ops;
  for (const op of REQUIRED_OPS) {
    const entry = ops[op];
    if (!entry || typeof entry.slug !== "string" || entry.slug === "") {
      problems.push(`logical op '${op}' has no slug mapped.`);
    } else if (DEPRECATED_SLUGS.includes(entry.slug)) {
      problems.push(`logical op '${op}' maps to deprecated slug '${entry.slug}'.`);
    }
  }
  return problems;
}

/**
 * Resolve a logical op to its lock entry, or throw COMPOSIO_TOOL_MISSING.
 * Does NOT check the toolkit version — the fake gateway and the arg-mapping
 * helper use it; only `requireOpSlug` is version-gated.
 */
export function resolveOp(lock: ToolLock, op: string): ToolLockOp {
  const entry = lock.ops[op];
  if (!entry || typeof entry.slug !== "string" || entry.slug === "") {
    throw new ComposioError("COMPOSIO_TOOL_MISSING", `logical op '${op}' has no slug mapped — run npm run composio:discover.`);
  }
  if (DEPRECATED_SLUGS.includes(entry.slug)) {
    throw new ComposioError("COMPOSIO_TOOL_MISSING", `logical op '${op}' maps to deprecated slug '${entry.slug}'.`);
  }
  return entry;
}

/**
 * Resolve a logical op to its slug, or throw COMPOSIO_TOOL_MISSING.
 * Every real execute call goes through here (CMP-03).
 */
export function requireOpSlug(lock: ToolLock, op: string): string {
  const problems = checkToolLock(lock);
  if (problems.length > 0) {
    throw new ComposioError("COMPOSIO_TOOL_MISSING", problems[0] as string);
  }
  return resolveOp(lock, op).slug;
}

/**
 * Translate logical call args into the tool's real arg names: `defaults` fill
 * anything the caller omitted, then `rename` rewrites the keys. Unknown caller
 * keys pass through untouched so a tool gaining an optional field needs no
 * lock change. This is the single place per-tool arg casing is decided.
 */
export function applyLockArgs(
  lock: ToolLock,
  op: string,
  args: Record<string, unknown>,
): { slug: string; args: Record<string, unknown> } {
  const entry = resolveOp(lock, op);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    out[entry.rename?.[key] ?? key] = value;
  }
  if (entry.defaults) {
    for (const [key, value] of Object.entries(entry.defaults)) {
      if (out[key] === undefined) out[key] = value;
    }
  }
  return { slug: entry.slug, args: out };
}
