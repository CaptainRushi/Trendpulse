import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioSheetsClient } from "../../src/sheets/composioClient.js";
import { SheetsApiError } from "../../src/sheets/client.js";

function stubFetch(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } })),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComposioSheetsClient errors", () => {
  it("keeps gateway object-errors readable (no [object Object])", async () => {
    stubFetch(401, JSON.stringify({ error: { message: "Invalid API key", code: 801 } }));
    const client = new ComposioSheetsClient("bad-key");
    const failure = await client.getTabTitles("sheet-id").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SheetsApiError);
    expect((failure as SheetsApiError).message).toBe("Invalid API key");
    expect((failure as SheetsApiError).status).toBe(401);
  });

  it("passes string tool-errors through", async () => {
    stubFetch(200, JSON.stringify({ successful: false, error: "sheet not shared" }));
    const client = new ComposioSheetsClient("key");
    const failure = await client.getTabTitles("sheet-id").catch((error: unknown) => error);
    expect((failure as SheetsApiError).message).toBe("sheet not shared");
  });
});
