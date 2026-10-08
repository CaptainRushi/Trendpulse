/**
 * Live routes (Doc 16 G3): samples series, SSE stream with Last-Event-ID
 * replay, and a rate-limited manual sample-now.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, badRequest } from "./errors.js";
import type { AppContext } from "./context.js";
import { appEvents } from "./context.js";
import { streamRunEvents } from "./sse.js";
import { latestSet, latestSetForCategory } from "../pulse/index.js";
import { readBaselines } from "../pulse/index.js";
import { CATEGORY_REGISTRY, CATEGORY_SLUGS, normalizeScope } from "../categories/registry.js";
import { isPipelineActive } from "../pulse/sampler.js";

const SamplesQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  top: z.coerce.number().int().min(1).max(10).optional(),
  scope: z.string().optional(),
  /** Doc-19 per-category set: lowercase slug (one category's latest). */
  category: z.string().optional(),
});

export function registerLive(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/live/samples", (request) => {
    const parsed = SamplesQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("Invalid query: date must be YYYY-MM-DD, top 1-10.");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.config.tz });
    const date = parsed.data.date ?? today;
    let scope = "all";
    if (parsed.data.scope !== undefined && parsed.data.scope !== "") {
      try {
        scope = normalizeScope(parsed.data.scope.split("+"));
      } catch {
        return { date, scope: parsed.data.scope, baseline_at: null, series: [] };
      }
    }
    const limit = parsed.data.top ?? ctx.config.pulseTopN;
    let set: ReturnType<typeof latestSet> = [];
    let category: string | undefined;
    if (parsed.data.category !== undefined && parsed.data.category !== "") {
      const slug = parsed.data.category.trim().toLowerCase();
      const entry = (CATEGORY_SLUGS as readonly string[]).includes(slug) ? CATEGORY_REGISTRY[slug] : undefined;
      if (!entry) throw badRequest(`Invalid query: category unknown category '${parsed.data.category}'.`);
      category = slug;
      set = latestSetForCategory(ctx.db, date, entry.label, limit);
    } else {
      set = latestSet(ctx.db, date, scope).slice(0, limit);
    }
    const baselines = readBaselines(ctx.db, date);
    const baselineAt = ctx.db
      .prepare("SELECT MIN(sampled_at) AS at FROM topic_samples WHERE sampled_at >= ? AND sampled_at < ?")
      .get(`${date}T00:00:00`, `${date}\uffff`) as { at: string | null } | undefined;
    const pointsStmt = ctx.db.prepare(
      "SELECT sampled_at AS t, index_value AS i, total AS total FROM topic_samples WHERE topic_id = ? AND sampled_at >= ? AND sampled_at < ? ORDER BY sampled_at DESC LIMIT 300",
    );
    const series = set.map((topic) => {
      const rows = pointsStmt.all(topic.topicId, `${date}T00:00:00`, `${date}\uffff`) as {
        t: string;
        i: number;
        total: number;
      }[];
      const points = [...rows].reverse().map((row) => ({ t: row.t, index: row.i, total: row.total }));
      const sources = [...new Set(topic.evidenceIds.map((id) => baselines.get(id)?.source).filter((s): s is string => !!s))];
      return {
        topic_id: topic.topicId,
        title: topic.title,
        rank: topic.rank,
        has_live_metric: points.length > 0,
        sources,
        points,
      };
    });
    return { date, scope, ...(category ? { category } : {}), baseline_at: baselineAt?.at ?? null, series };
  });

  app.get("/api/live/stream", (request, reply) => {
    const header = request.headers["last-event-id"];
    const lastId = Array.isArray(header) ? header[0] : header;
    const afterSeq = lastId !== undefined && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
    reply.hijack();
    streamRunEvents(request, reply, appEvents(ctx), "pulse", afterSeq === undefined ? {} : { afterSeq });
  });

  app.post("/api/live/sample-now", async () => {
    const sampler = ctx.pulse;
    if (!sampler) throw badRequest("Pulse sampler is disabled (PULSE_ENABLED=false).");
    if (sampler.isRunning() || isPipelineActive(ctx.db)) {
      throw new ApiError(409, "RUN_LOCKED", "A sample cycle or pipeline run is already active.");
    }
    if (Date.now() - sampler.lastManualAt < 60_000) {
      throw new ApiError(429, "RATE_LIMITED", "sample-now is limited to one call per 60 seconds.");
    }
    sampler.lastManualAt = Date.now();
    return sampler.runCycle("manual");
  });
}
