import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /api/health", () => {
  it("returns ok:true with version and setup flag", async () => {
    const app = buildApp({ version: "0.1.0-test" });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body["ok"]).toBe(true);
    expect(body["version"]).toBe("0.1.0-test");
    expect(body["setup_complete"]).toBe(false);
    await app.close();
  });

  it("never exposes secret values", async () => {
    process.env["OMNIROUTE_API_KEY"] = "should-not-leak";
    const app = buildApp({ version: "0.1.0-test" });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.body).not.toContain("should-not-leak");
    delete process.env["OMNIROUTE_API_KEY"];
    await app.close();
  });

  it("answers 404 with the error envelope on unknown routes", async () => {
    const app = buildApp({ version: "0.1.0-test" });
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
    await app.close();
  });
});
