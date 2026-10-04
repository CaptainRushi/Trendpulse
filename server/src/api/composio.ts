/**
 * Composio integration routes (docs/15 §6). Thin wrappers: every decision
 * lives in auth.ts / gateway.ts / budget.ts. The API key is never echoed —
 * status reports `is_set` only.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { AppContext } from "./context.js";
import { appLogger } from "./context.js";
import { readSettingsMap, writeSetting } from "../config/settings.js";
import {
  ensureAuthConfig,
  getConnection,
  preflightComposio,
  startConnection,
  type AuthContext,
} from "../integrations/composio/auth.js";
import { createGateway } from "../integrations/composio/gateway.js";
import { budgetUsage, usageBySlug } from "../integrations/composio/budget.js";
import { checkToolLock, loadToolLock } from "../integrations/composio/tool-map.js";
import { ComposioError } from "../integrations/composio/errors.js";

/** Stored connection, or null when never connected. */
function storedConnection(ctx: AppContext): { status: string; accountId: string; requestId: string } | null {
  const raw: unknown = readSettingsMap(ctx.db).get("composio_connection");
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof record[key] === "string" ? record[key] : "");
  return { status: str("status"), accountId: str("accountId"), requestId: str("requestId") };
}

function authCtx(ctx: AppContext): AuthContext {
  return {
    apiKey: ctx.config.composioApiKey,
    userId: ctx.config.composioUserId,
    timeoutMs: ctx.config.composioCallTimeoutMs,
  };
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ComposioError) {
    const status = error.code === "COMPOSIO_NOT_CONFIGURED" || error.code === "COMPOSIO_NOT_CONNECTED" ? 400 : 502;
    return new ApiError(status, error.code, error.message);
  }
  return new ApiError(500, "INTERNAL", error instanceof Error ? error.message : String(error));
}

export function registerComposio(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/integrations/composio/status", () => {
    const lock = loadToolLock();
    const usage = budgetUsage(ctx.db, ctx.config.composioMonthlyCallBudget);
    const connection = storedConnection(ctx);
    const connectionStatus = connection === null || connection.status === "" ? "NONE" : connection.status;
    const blockers = preflightComposio({
      apiKey: ctx.config.composioApiKey,
      sheetId: ctx.config.googleSheetId,
      lock,
      budgetUsed: usage.used,
      budgetLimit: usage.limit,
      connectionStatus,
    });
    return {
      configured: ctx.config.composioApiKey !== "",
      connection: { status: connectionStatus, account_id: connection === null ? "" : connection.accountId },
      auth_config_id: ctx.config.composioGooglesheetsAuthConfigId,
      toolkit_version: lock.version,
      budget: { used: usage.used, limit: usage.limit, warning: usage.warning, exhausted: usage.exhausted },
      lock_problems: checkToolLock(lock),
      blockers: blockers.blockers,
      warnings: blockers.warnings,
      spreadsheet_id: ctx.config.googleSheetId,
      read_strategy: ctx.config.sheetsReadStrategy,
    };
  });

  app.post("/api/integrations/composio/connect", async () => {
    if (ctx.config.composioApiKey === "") {
      throw new ApiError(400, "COMPOSIO_NOT_CONFIGURED", "COMPOSIO_API_KEY is not set.");
    }
    try {
      const authConfigId = await ensureAuthConfig(authCtx(ctx), ctx.config.composioGooglesheetsAuthConfigId);
      const started = await startConnection(authCtx(ctx), authConfigId);
      writeSetting(ctx.db, "composio_connection", { status: "WAITING", requestId: started.requestId });
      return { redirect_url: started.redirectUrl, request_id: started.requestId };
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/integrations/composio/connect/:id", async (request) => {
    try {
      const current = await getConnection(authCtx(ctx), request.params.id);
      if (current.status === "ACTIVE" && current.accountId) {
        writeSetting(ctx.db, "composio_connection", {
          status: "ACTIVE",
          accountId: current.accountId,
          requestId: request.params.id,
        });
      }
      return { status: current.status, account_id: current.accountId ?? "" };
    } catch (error) {
      appLogger(ctx).warn({ err: error instanceof Error ? error.message : String(error) }, "composio connect poll failed");
      throw toApiError(error);
    }
  });

  app.post<{ Body?: unknown }>("/api/integrations/composio/sheet/create", async (request) => {
    if (ctx.config.composioApiKey === "") {
      throw new ApiError(400, "COMPOSIO_NOT_CONFIGURED", "COMPOSIO_API_KEY is not set.");
    }
    const parsed = z.object({ title: z.string().min(1) }).safeParse(request.body ?? {});
    const title = parsed.success ? parsed.data.title : "TrendPulse";
    try {
      const gateway = createGateway(authCtx(ctx));
      const created = await gateway.execute("createSpreadsheet", { title });
      if (!created.ok) throw new ComposioError("COMPOSIO_TOOL_ERROR", created.error ?? "create failed");
      const data = created.data as { spreadsheetId?: string; spreadsheetUrl?: string } | undefined;
      if (!data?.spreadsheetId) throw new ComposioError("COMPOSIO_TOOL_ERROR", "spreadsheet create returned no id.");
      writeSetting(ctx.db, "sheet_id", data.spreadsheetId);
      return { spreadsheet_id: data.spreadsheetId, spreadsheet_url: data.spreadsheetUrl ?? "" };
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.get("/api/integrations/composio/usage", () => {
    const usage = budgetUsage(ctx.db, ctx.config.composioMonthlyCallBudget);
    return { budget: { used: usage.used, limit: usage.limit }, calls: usageBySlug(ctx.db) };
  });

  }
