import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

export interface AppOptions {
  version: string;
}

/**
 * Extract an HTTP status from an unknown thrown value. Fastify errors carry
 * numeric statusCode; anything else is a 500.
 */
function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code: unknown = error.statusCode;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  return 500;
}

/**
 * App factory (kept separate from index.ts boot so tests can use
 * fastify.inject without opening ports or touching the DB).
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/health", () => ({
    ok: true,
    version: options.version,
    setup_complete: false,
    sheets: "unknown",
    omniroute: "unknown",
    jev: "unknown",
    next_run_at: null,
    last_run: null,
  }));

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Route not found.", hint: "See the API table in docs/05_BACKEND_SCHEMA.md." },
    });
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = statusCodeOf(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL" : "VALIDATION",
        message: statusCode === 500 ? "Internal server error." : message,
      },
    });
  });

  return app;
}
