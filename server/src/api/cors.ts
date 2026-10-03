/**
 * CORS: same-origin only, plus the Vite dev origin outside production.
 * Browsers already block foreign reads when no ACAO header is echoed, but
 * an explicit 403 gives curl and other non-browser clients a clear answer.
 * Requests without an Origin header (curl, same-origin navigations, tests)
 * always pass. Preflight short-circuits here, ahead of the password gate
 * (browsers never attach Basic auth to a preflight).
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";

const DEV_ORIGINS = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

export function registerCors(app: FastifyInstance, ctx: AppContext): void {
  const own = new Set([
    `http://${ctx.config.host}:${String(ctx.config.port)}`,
    ...(ctx.config.host === "127.0.0.1" ? [`http://localhost:${String(ctx.config.port)}`] : []),
  ]);
  const allowed = (origin: string): boolean => {
    if (own.has(origin)) return true;
    if (process.env["NODE_ENV"] !== "production" && DEV_ORIGINS.has(origin)) return true;
    return false;
  };

  app.addHook("onRequest", (request, reply, done) => {
    const raw: unknown = request.headers.origin;
    const origin =
      typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : undefined;
    if (origin === undefined) {
      done();
      return;
    }
    if (!allowed(origin)) {
      reply.code(403).send({
        error: {
          code: "VALIDATION",
          message: "Foreign origin blocked.",
          hint: "Open the dashboard on this host instead of a third-party page.",
        },
      });
      return;
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    if (request.method === "OPTIONS") {
      reply
        .code(204)
        .header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .header("Access-Control-Max-Age", "86400")
        .send();
      return;
    }
    done();
  });
}
