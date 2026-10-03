/**
 * App factory (kept separate from index.ts boot so tests can use
 * fastify.inject without opening ports). All Phase 7 routes register here:
 * health, trends (+topic/digest/raw/dates), exports, sources, settings,
 * sheets admin, runs (+retry/stream), setup probes. Errors funnel through
 * the schema §4 envelope; unexpected 500s are logged, never leaked.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerPasswordGate } from "./api/auth.js";
import type { AppContext } from "./api/context.js";
import { appLogger } from "./api/context.js";
import { registerCors } from "./api/cors.js";
import { mapError } from "./api/errors.js";
import { registerExports } from "./api/exports.js";
import { registerHealth } from "./api/health.js";
import { registerJevHealth } from "./api/jev.js";
import { registerRuns } from "./api/runs.js";
import { registerSettings } from "./api/settings.js";
import { registerSetup } from "./api/setup.js";
import { registerSheets } from "./api/sheets.js";
import { registerSources } from "./api/sources.js";
import { registerTrends } from "./api/trends.js";

export type { AppContext };

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const log = appLogger(ctx);

  registerCors(app, ctx);
  registerPasswordGate(app, ctx.config.dashboardPassword);

  registerHealth(app, ctx);
  registerJevHealth(app, ctx);
  registerTrends(app, ctx);
  registerExports(app, ctx);
  registerSources(app, ctx);
  registerSettings(app, ctx);
  registerSheets(app, ctx);
  registerRuns(app, ctx);
  registerSetup(app, ctx);

  // Handlers first: encapsulated plugin contexts (fastify-static below)
  // inherit the root error/not-found handlers only when they exist before
  // the plugin boots — setting them after lets plugin errors (and route
  // errors, once static adds its hooks) fall through to Fastify defaults.
  const spa = ctx.staticDir && existsSync(join(ctx.staticDir, "index.html")) ? ctx.staticDir : null;
  app.setNotFoundHandler((request, reply) => {
    // SPA fallback: frontend routes serve index.html; only /api/* gets JSON 404s.
    if (spa && !request.url.startsWith("/api/")) {
      reply.sendFile("index.html");
      return;
    }
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        hint: "See the API table in docs/05_BACKEND_SCHEMA.md.",
      },
    });
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const mapped = mapError(error);
    if (mapped.statusCode === 500) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "unhandled route error");
    }
    reply.code(mapped.statusCode).send(mapped.body);
  });

  if (spa) {
    await app.register(fastifyStatic, { root: spa });
  }

  return app;
}
