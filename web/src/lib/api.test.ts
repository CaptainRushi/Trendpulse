import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  it("maps envelope errors to ApiError with code and hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: { code: "RUN_LOCKED", message: "Busy.", hint: "Wait." } }),
    ));
    const error = await api.get("/api/runs").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("RUN_LOCKED");
    expect((error as ApiError).hint).toBe("Wait.");
    expect((error as ApiError).status).toBe(409);
  });

  it("maps network failure to OFFLINE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const error = await api.get("/api/health").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("OFFLINE");
  });

  it("rejects non-JSON with INTERNAL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>nope</html>", { status: 200 })));
    const error = await api.get("/api/health").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("INTERNAL");
  });
});
