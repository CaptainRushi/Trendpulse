/**
 * App factory (kept separate from index.ts boot so tests can use
 * fastify.inject without opening ports). All Phase 7 routes register here:
 * health, trends (+topic/digest/raw/dates), exports, sources, settings,
 * sheets admin, runs (+retry/stream), setup probes. Errors funnel through
 * the schema §4 envelope; unexpected 500s are logged, never leaked.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerPasswordGate } from "./api/auth.js";
import type { AppContext } from "./api/context.js";
import { appLogger } from "./api/context.js";
import { mapError } from "./api/errors.js";
import { registerExports } from "./api/exports.js";
import { registerHealth } from "./api/health.js";
import { registerRuns } from "./api/runs.js";
import { registerSettings } from "./api/settings.js";
import { registerSetup } from "./api/setup.js";
import { registerSheets } from "./api/sheets.js";
import { registerSources } from "./api/sources.js";
import { registerTrends } from "./api/trends.js";

export type { AppContext };

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  const log = appLogger(ctx);

  registerPasswordGate(app, ctx.config.dashboardPassword);

  registerHealth(app, ctx);
  registerTrends(app, ctx);
  registerExports(app, ctx);
  registerSources(app, ctx);
  registerSettings(app, ctx);
  registerSheets(app, ctx);
  registerRuns(app, ctx);
  registerSetup(app, ctx);

  app.setNotFoundHandler((_request, reply) => {
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

  return app;
}
