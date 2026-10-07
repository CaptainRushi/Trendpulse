/**
 * Runs: list, detail, launch (202 + background), retry (202 + background),
 * live SSE stream. Launch paths use the synchronous-setup background
 * variants so a busy pipeline answers 409 before any 202.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "../utils/ulid.js";
import { STAGES } from "../pipeline/orchestrator.js";
import { badRequest, notFound } from "./errors.js";
import type { AppContext } from "./context.js";
import { appEvents, appLogger, appOrchestrator } from "./context.js";
import { streamRunEvents } from "./sse.js";
import { SourceKey } from "../sheets/schema.js";
import { estimateRun } from "../categories/estimate.js";
import { CATEGORY_SLUGS, validateMyCategories } from "../categories/registry.js";
import { categoryOverrides } from "../categories/collect.js";
import { QUESTION_SET_VERSION } from "../sorting/questions.js";
import {
  effectiveIncludeGeneralSources,
  effectiveMaxCategories,
  effectiveSortBatchSize,
  effectiveTopPerCategory,
  readMyCategories,
} from "../config/settings.js";
import { replaySortEvents } from "../pipeline/sortEvents.js";

const RunRow = z.object({
  run_id: z.string(),
  run_date: z.string(),
  trigger: z.string(),
  status: z.string(),
  stages_requested: z.array(z.string()),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  items_collected: z.number().int(),
  items_new: z.number().int(),
  topics_count: z.number().int(),
  error: z.string().nullable(),
});

const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const PostRunsBody = z
  .object({
    stages: z.array(z.enum(STAGES)).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
    sources: z.array(SourceKey).optional(),
    limit: z.number().int().min(1).optional(),
    categories: z.array(z.string()).max(CATEGORY_SLUGS.length).optional(),
    mode: z.enum(["strict", "loose"]).optional(),
  })
  .strict();

const RetryBody = z
  .object({
    from_stage: z.enum(STAGES).optional(),
  })
  .strict();

interface RunRowShape {
  id: string;
  run_date: string;
  trigger: string;
  status: string;
  stages_requested: string;
  started_at: string;
  finished_at: string | null;
  items_collected: number;
  items_new: number;
  topics_count: number;
  error: string | null;
}

function toRunRow(row: RunRowShape): z.infer<typeof RunRow> {
  let stages: unknown = [];
  try {
    stages = JSON.parse(row.stages_requested) as unknown;
  } catch {
    stages = [];
  }
  return RunRow.parse({
    run_id: row.id,
    run_date: row.run_date,
    trigger: row.trigger,
    status: row.status,
    stages_requested: stages,
    started_at: row.started_at,
    finished_at: row.finished_at,
    items_collected: row.items_collected,
    items_new: row.items_new,
    topics_count: row.topics_count,
    error: row.error,
  });
}

const EstimateBody = z.object({
  categories: z.array(z.string()).max(CATEGORY_SLUGS.length).optional(),
  mode: z.enum(["strict", "loose"]).optional(),
});

export function registerRuns(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/runs/estimate", (request) => {
    const parsed = EstimateBody.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest("Body must be { categories?: string[], mode?: strict|loose }.");
    const requested = parsed.data.categories !== undefined && parsed.data.categories.length > 0
      ? parsed.data.categories
      : readMyCategories(ctx.db);
    if (requested.length === 0) {
      throw badRequest("NO_CATEGORIES_SELECTED: pick at least one category before estimating.");
    }
    let categories: string[];
    try {
      categories = validateMyCategories(requested, effectiveMaxCategories(ctx.db, ctx.config));
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "invalid categories");
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
    const includeGeneral = effectiveIncludeGeneralSources(ctx.db, ctx.config);
    return estimateRun(
      ctx.db,
      {
        categories,
        mode: parsed.data.mode ?? "strict",
        overrides: categoryOverrides(ctx.db),
        redditCreds: ctx.config.redditClientId !== "" && ctx.config.redditClientSecret !== "",
        jevModel: ctx.config.jevModel,
        questionVersion: QUESTION_SET_VERSION,
        topPerCategory: effectiveTopPerCategory(ctx.db, ctx.config),
        batchSize: effectiveSortBatchSize(ctx.db, ctx.config),
        includeGeneralSources: includeGeneral,
      },
      today,
      ctx.config.jevPricePerMInput,
    );
  });

  app.get("/api/runs", (request) => {
    const parsed = RunsQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("Invalid query: limit/offset must be integers.");
    const total = (ctx.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    const rows = ctx.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?")
      .all(parsed.data.limit, parsed.data.offset) as RunRowShape[];
    return z
      .object({ runs: z.array(RunRow), total: z.number().int() })
      .parse({ runs: rows.map(toRunRow), total });
  });

  app.get("/api/runs/:id", (request) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) throw badRequest("Invalid run id.");
    const row = ctx.db.prepare("SELECT * FROM runs WHERE id = ?").get(params.data.id) as
      | RunRowShape
      | undefined;
    if (!row) throw notFound(`No run '${params.data.id}'.`);
    const stages = ctx.db
      .prepare("SELECT stage, status, started_at, finished_at FROM run_stages WHERE run_id = ?")
      .all(params.data.id) as { stage: string; status: string; started_at: string | null; finished_at: string | null }[];
    const sourceStats = ctx.db
      .prepare("SELECT source, status, items, duration_ms, error FROM run_source_stats WHERE run_id = ?")
      .all(params.data.id) as { source: string; status: string; items: number; duration_ms: number; error: string | null }[];
    const usage = ctx.db
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut FROM llm_calls WHERE run_id = ?",
      )
      .get(params.data.id) as { calls: number; tokensIn: number; tokensOut: number };
    return {
      run: toRunRow(row),
      stages,
      source_stats: sourceStats,
      llm: { calls: usage.calls, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut },
    };
  });

  app.post("/api/runs", async (request, reply) => {
    const parsed = PostRunsBody.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`Invalid body${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
    }
    const orch = appOrchestrator(ctx);
    const runId = ulid();
    const { done } = orch.startRunBackground({
      trigger: "manual",
      runId,
      ...(parsed.data.date ? { runDate: parsed.data.date } : {}),
      ...(parsed.data.stages ? { stages: parsed.data.stages } : {}),
      ...(parsed.data.sources ? { sources: parsed.data.sources } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.categories ? { categories: parsed.data.categories } : {}),
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
    });
    done.catch((error: unknown) => {
      appLogger(ctx).error(
        { runId, err: error instanceof Error ? error.message : String(error) },
        "background run failed",
      );
    });
    reply.code(202).send({ run_id: runId });
  });

  app.post("/api/runs/:id/retry", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) throw badRequest("Invalid run id.");
    const parsed = RetryBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`Invalid body${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
    }
    const orch = appOrchestrator(ctx);
    const { done } = orch.retryRunBackground(params.data.id, parsed.data.from_stage);
    done.catch((error: unknown) => {
      appLogger(ctx).error(
        { runId: params.data.id, err: error instanceof Error ? error.message : String(error) },
        "background retry failed",
      );
    });
    reply.code(202).send({ run_id: params.data.id });
  });

  app.get("/api/runs/:id/stream", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) throw badRequest("Invalid run id.");
    const row = ctx.db.prepare("SELECT id FROM runs WHERE id = ?").get(params.data.id) as
      | { id: string }
      | undefined;
    if (!row) throw notFound(`No run '${params.data.id}'.`);
    const header = request.headers["last-event-id"];
    const lastId = Array.isArray(header) ? header[0] : header;
    const afterSeq = lastId !== undefined && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
    reply.hijack();
    streamRunEvents(request, reply, appEvents(ctx), params.data.id, afterSeq === undefined ? {} : { afterSeq });
  });

  app.get("/api/runs/active", () => {
    const row = ctx.db
      .prepare("SELECT id, scope_key FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string; scope_key: string } | undefined;
    if (!row) return { run_id: null, scope: "all" };
    return { run_id: row.id, scope: row.scope_key || "all" };
  });

  app.get("/api/runs/:id/sort-state", (request) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) throw badRequest("Invalid run id.");
    const row = ctx.db.prepare("SELECT id, status FROM runs WHERE id = ?").get(params.data.id) as
      | { id: string; status: string }
      | undefined;
    if (!row) throw notFound(`No run '${params.data.id}'.`);
    // Snapshot == replay by construction: state rebuilds from stored events.
    const events = replaySortEvents(ctx.db, params.data.id);
    const phases = events
      .filter((e) => e["type"] === "sort_phase")
      .map((e) => (typeof e["phase"] === "string" ? e["phase"] : ""));
    return {
      run_id: params.data.id,
      status: row.status,
      phase: phases.length > 0 ? phases[phases.length - 1] : null,
      events,
    };
  });
}
