/**
 * Optional password protection (TRD §12): when DASHBOARD_PASSWORD is set
 * (required for non-loopback binds), every /api route needs HTTP Basic
 * with a matching password. Username is ignored. Unset password =
 * open localhost (default). Failures are 401 UNAUTHORIZED, never redirects
 * (this is an API + SPA, not a login form).
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

function passwordsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerPasswordGate(app: FastifyInstance, dashboardPassword: string): void {
  if (dashboardPassword === "") return;
  app.addHook("onRequest", (request, reply, done) => {
    const header = request.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    let ok = false;
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        const password = separator === -1 ? decoded : decoded.slice(separator + 1);
        ok = passwordsEqual(password, dashboardPassword);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="TrendPulse"')
        .send({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required.",
            hint: "Provide the dashboard password via HTTP Basic auth.",
          },
        });
      return;
    }
    done();
  });
}
