/**
 * GET /api/health — liveness + dependency states for the dashboard.
 * Every sub-check is guarded: health never throws. Service states are
 * reachability only (Jev uses a models-list, never an inference call).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveJevEndpoint } from "../config/env.js";
import { LlmClient } from "../llm/client.js";
import { testOmnirouteConnection } from "../llm/probe.js";
import type { AppContext } from "./context.js";
import { appRepo } from "./context.js";

const ServiceState = z.enum(["ok", "error"]);

const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  setup_complete: z.boolean(),
  sheets: ServiceState,
  omniroute: ServiceState,
  jev: ServiceState,
  next_run_at: z.string().nullable(),
  last_run: z
    .object({ run_id: z.string(), run_date: z.string(), status: z.string() })
    .nullable(),
});

interface LastRun {
  run_id: string;
  run_date: string;
  status: string;
}

export function registerHealth(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/health", async () => {
    let setupComplete = false;
    try {
      const row = ctx.db
        .prepare("SELECT value_json FROM settings WHERE key = 'setup_complete'")
        .get() as { value_json: string } | undefined;
      setupComplete = row !== undefined && (JSON.parse(row.value_json) as unknown) === true;
    } catch {
      setupComplete = false;
    }

    const [sheets, omniroute, jev] = await Promise.all([
      checkSheets(ctx),
      checkOmniroute(ctx),
      checkJev(ctx),
    ]);

    let lastRun: LastRun | null = null;
    try {
      const row = ctx.db
        .prepare("SELECT id, run_date, status FROM runs ORDER BY started_at DESC LIMIT 1")
        .get() as { id: string; run_date: string; status: string } | undefined;
      if (row) lastRun = { run_id: row.id, run_date: row.run_date, status: row.status };
    } catch {
      lastRun = null;
    }

    // next_run_at comes straight from the live scheduler (node-cron v4
    // exposes the next fire time); null when no scheduler is attached.
    return HealthResponse.parse({
      ok: true,
      version: ctx.version,
      setup_complete: setupComplete,
      sheets,
      omniroute,
      jev,
      next_run_at: ctx.scheduler?.nextRunAt() ?? null,
      last_run: lastRun,
    });
  });
}

async function checkSheets(ctx: AppContext): Promise<"ok" | "error"> {
  try {
    await appRepo(ctx).ping();
    return "ok";
  } catch {
    return "error";
  }
}

async function checkOmniroute(ctx: AppContext): Promise<"ok" | "error"> {
  try {
    const result = await testOmnirouteConnection({
      baseUrl: ctx.config.omnirouteBaseUrl,
      apiKey: ctx.config.omnirouteApiKey || undefined,
      timeoutMs: 8000,
    });
    return result.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function checkJev(ctx: AppContext): Promise<"ok" | "error"> {
  try {
    const endpoint = resolveJevEndpoint(ctx.config);
    const client = new LlmClient({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: "",
      clientName: "jev",
      timeoutMs: 8000,
      maxAttempts: 1,
    });
    await client.listModels();
    return "ok";
  } catch {
    return "error";
  }
}
