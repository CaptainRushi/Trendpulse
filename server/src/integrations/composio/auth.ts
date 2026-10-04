/**
 * Composio auth (docs/15 PACKAGE C2) — find or create the managed Google
 * Sheets auth config, start a connection (connect link), poll until ACTIVE.
 *
 * REST endpoint shapes are best-effort (live key unavailable — see
 * DECISIONS.md); parsing accepts every documented field-name variant so a
 * shape drift surfaces as a readable error, never a crash.
 */
import { ComposioError, type ComposioCode } from "./errors.js";
import { checkToolLock, type ToolLock } from "./tool-map.js";

const API_BASE = "https://backend.composio.dev";
const TOOLKIT = "googlesheets";
/** Endpoint paths — re-verify live in C6 (docs/15 FACTS-3). */
const AUTH_CONFIGS_PATH = "/api/v3/auth_configs";
const CONNECTED_ACCOUNTS_PATH = "/api/v3/connected_accounts";

export interface AuthContext {
  apiKey: string;
  userId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface ConnectionInfo {
  requestId: string;
  redirectUrl: string;
  status: string;
  accountId?: string | undefined;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function pickList(obj: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

async function composioRest(
  ctx: AuthContext,
  path: string,
  init: { method: string; query?: string; body?: unknown },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ctx.timeoutMs);
  try {
    const request: RequestInit = {
      method: init.method,
      headers: { "x-api-key": ctx.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    const res = await (ctx.fetchImpl ?? fetch)(`${API_BASE}${path}${init.query ?? ""}`, request);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ComposioError("COMPOSIO_TOOL_ERROR", `Composio ${path} returned non-JSON (${String(res.status)})`);
    }
    if (!res.ok) {
      // Gateway errors nest the message ({error: {message, code}}); accept both shapes.
      const top = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      const nested = top["error"] !== null && typeof top["error"] === "object" ? (top["error"] as Record<string, unknown>) : {};
      const message =
        pickString(top, ["message", "error"]) ||
        pickString(nested, ["message"]) ||
        `request failed (${String(res.status)})`;
      throw new ComposioError("COMPOSIO_TOOL_ERROR", `Composio ${path}: ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Find the existing managed auth config, or create one. Returns its id. */
export async function ensureAuthConfig(ctx: AuthContext, existingId: string): Promise<string> {
  if (ctx.apiKey === "") {
    throw new ComposioError("COMPOSIO_NOT_CONFIGURED", "COMPOSIO_API_KEY not set — run npm run composio:setup.");
  }
  if (existingId !== "") return existingId;
  const listed = (await composioRest(ctx, AUTH_CONFIGS_PATH, {
    method: "GET",
    query: `?toolkit_slug=${TOOLKIT}&limit=50`,
  })) as Record<string, unknown>;
  const found = pickList(listed, ["items", "auth_configs", "data"]).find(
    (entry) => pickString(entry, ["toolkit_slug", "toolkitSlug", "toolkit"]) === TOOLKIT,
  );
  const foundId = found ? pickString(found, ["id", "auth_config_id", "authConfigId"]) : "";
  if (foundId !== "") return foundId;
  const created = (await composioRest(ctx, AUTH_CONFIGS_PATH, {
    method: "POST",
    body: { toolkit_slug: TOOLKIT, type: "use_composio_managed_auth", name: `trendpulse-${ctx.userId}` },
  })) as Record<string, unknown>;
  const createdId = pickString(created, ["id", "auth_config_id", "authConfigId"]);
  if (createdId === "") {
    throw new ComposioError("COMPOSIO_TOOL_ERROR", "auth config create returned no id — re-verify endpoint shapes live.");
  }
  return createdId;
}

/** Start a Google connection; returns the link the user approves. */
export async function startConnection(ctx: AuthContext, authConfigId: string): Promise<ConnectionInfo> {
  const started = (await composioRest(ctx, `${CONNECTED_ACCOUNTS_PATH}/initiate`, {
    method: "POST",
    body: { user_id: ctx.userId, auth_config_id: authConfigId },
  })) as Record<string, unknown>;
  const redirectUrl = pickString(started, ["redirect_url", "redirectUrl", "url"]);
  const requestId = pickString(started, ["id", "request_id", "requestId", "connection_id", "connectionId"]);
  if (redirectUrl === "") {
    throw new ComposioError("COMPOSIO_TOOL_ERROR", "connection initiate returned no redirect link.");
  }
  return { requestId, redirectUrl, status: "waiting" };
}

export async function getConnection(ctx: AuthContext, requestId: string): Promise<ConnectionInfo> {
  const current = (await composioRest(ctx, `${CONNECTED_ACCOUNTS_PATH}/${requestId}`, { method: "GET" })) as Record<string, unknown>;
  return {
    requestId,
    redirectUrl: pickString(current, ["redirect_url", "redirectUrl"]),
    status: pickString(current, ["status", "state"]).toUpperCase() || "WAITING",
    accountId: pickString(current, ["account_id", "accountId", "connected_account_id", "connectedAccountId"]) || undefined,
  };
}

/** Poll until ACTIVE (default 5 min). INACTIVE/FAILED → AUTH_EXPIRED. */
export async function waitForActive(
  ctx: AuthContext,
  requestId: string,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConnectionInfo> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await getConnection(ctx, requestId);
    if (current.status === "ACTIVE") return current;
    if (current.status === "INACTIVE" || current.status === "FAILED" || current.status === "EXPIRED") {
      throw new ComposioError("COMPOSIO_AUTH_EXPIRED", "connection went inactive — reconnect from Settings → Connections.");
    }
    if (Date.now() >= deadline) {
      throw new ComposioError("COMPOSIO_NOT_CONNECTED", "connection still waiting after timeout — approve the link and retry.");
    }
    await sleep(intervalMs);
  }
}

export interface PreflightInput {
  apiKey: string;
  sheetId: string;
  lock: ToolLock;
  budgetUsed: number;
  budgetLimit: number;
  connectionStatus: string;
}

export interface PreflightResult {
  blockers: ComposioCode[];
  warnings: string[];
}

/** Pure blocker/warning math (CMP-01); status comes from getConnection. */
export function preflightComposio(input: PreflightInput): PreflightResult {
  const blockers: ComposioCode[] = [];
  const warnings: string[] = [];
  if (input.apiKey === "") blockers.push("COMPOSIO_NOT_CONFIGURED");
  if (input.connectionStatus !== "ACTIVE") blockers.push("COMPOSIO_NOT_CONNECTED");
  if (input.sheetId === "") blockers.push("SHEET_ID_INVALID");
  if (checkToolLock(input.lock).length > 0) blockers.push("COMPOSIO_TOOL_MISSING");
  if (input.budgetLimit > 0 && input.budgetUsed >= input.budgetLimit) {
    blockers.push("COMPOSIO_BUDGET_EXCEEDED");
  } else if (input.budgetLimit > 0 && input.budgetUsed >= input.budgetLimit * 0.8) {
    warnings.push(`Composio usage at ${String(Math.round((input.budgetUsed / input.budgetLimit) * 100))}% of monthly budget.`);
  }
  return { blockers, warnings };
}
