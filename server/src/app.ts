import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { testJevConnection, testOmnirouteConnection } from "./llm/probe.js";

export interface AppOptions {
  version: string;
  /** Jev fallback when the test-jev body leaves base_url empty (server config). */
  omnirouteBaseUrl?: string | undefined;
  omnirouteApiKey?: string | undefined;
}

const TestOmnirouteBody = z.object({
  base_url: z.string().url(),
  api_key: z.string().optional(),
});

const TestJevBody = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().min(1),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const error = new Error(
      `Invalid request body${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    ) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return result.data;
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

  // Setup probes (Phase 2): reachable without setup_complete, never echo keys.
  app.post("/api/setup/test-omniroute", async (request) => {
    const body = parseBody(TestOmnirouteBody, request.body);
    const result = await testOmnirouteConnection({ baseUrl: body.base_url, apiKey: body.api_key });
    if (!result.ok) return { ok: false, error: result.error, latency_ms: result.latencyMs };
    return { ok: true, models: result.models, latency_ms: result.latencyMs };
  });

  app.post("/api/setup/test-jev", async (request) => {
    const body = parseBody(TestJevBody, request.body);
    const result = await testJevConnection({
      baseUrl: body.base_url ?? "",
      apiKey: body.api_key,
      model: body.model,
      fallback:
        options.omnirouteBaseUrl !== undefined
          ? { baseUrl: options.omnirouteBaseUrl, apiKey: options.omnirouteApiKey ?? "" }
          : undefined,
    });
    if (!result.ok) return { ok: false, error: result.error, latency_ms: result.latencyMs };
    return { ok: true, model: result.model, latency_ms: result.latencyMs };
  });

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
