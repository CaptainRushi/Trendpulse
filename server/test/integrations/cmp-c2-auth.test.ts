import { describe, expect, it } from "vitest";
import {
  ensureAuthConfig,
  preflightComposio,
  startConnection,
  waitForActive,
} from "../../src/integrations/composio/auth.js";
import type { AuthContext } from "../../src/integrations/composio/auth.js";
import { loadToolLock } from "../../src/integrations/composio/tool-map.js";
import type { ComposioError } from "../../src/integrations/composio/errors.js";

function stubFetch(responses: { status: number; body: unknown }[]): AuthContext {
  const queue = [...responses];
  return {
    apiKey: "k",
    userId: "trendpulse-local",
    timeoutMs: 5000,
    fetchImpl: () => {
      const next = queue.shift() ?? { status: 500, body: {} };
      return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
    },
  };
}

const PINNED = { ...loadToolLock(), version: "20260817_00" };

describe("CMP-02 auth and connect", () => {
  it("keeps a configured auth id without network", async () => {
    const ctx = stubFetch([]);
    await expect(ensureAuthConfig(ctx, "ac_saved")).resolves.toBe("ac_saved");
  });

  it("finds the managed config, or creates it", async () => {
    const found = stubFetch([{ status: 200, body: { items: [{ toolkit_slug: "googlesheets", id: "ac_123" }] } }]);
    await expect(ensureAuthConfig(found, "")).resolves.toBe("ac_123");
    const created = stubFetch([
      { status: 200, body: { items: [] } },
      { status: 200, body: { id: "ac_new" } },
    ]);
    await expect(ensureAuthConfig(created, "")).resolves.toBe("ac_new");
  });

  it("missing key fails with COMPOSIO_NOT_CONFIGURED", async () => {
    await expect(ensureAuthConfig({ apiKey: "", userId: "u", timeoutMs: 1000 }, "")).rejects.toMatchObject({
      code: "COMPOSIO_NOT_CONFIGURED",
    } satisfies { code: string });
  });

  it("connect link, ACTIVE poll, INACTIVE expiry", async () => {
    const ctx = stubFetch([{ status: 200, body: { redirect_url: "https://connect.example/r", request_id: "req_1" } }]);
    const started = await startConnection(ctx, "ac_123");
    expect(started.redirectUrl).toBe("https://connect.example/r");
    const polling = stubFetch([
      { status: 200, body: { status: "waiting" } },
      { status: 200, body: { status: "ACTIVE", connected_account_id: "acc_9" } },
    ]);
    const active = await waitForActive(polling, "req_1", { intervalMs: 1, sleep: () => Promise.resolve() });
    expect(active.accountId).toBe("acc_9");
    const dead = stubFetch([{ status: 200, body: { status: "INACTIVE" } }]);
    let thrown: unknown;
    try {
      await waitForActive(dead, "req_x", { intervalMs: 1, sleep: () => Promise.resolve() });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ComposioError).code).toBe("COMPOSIO_AUTH_EXPIRED");
  });
});

describe("CMP-01 preflight blockers", () => {
  it("healthy input has no blockers", () => {
    expect(
      preflightComposio({ apiKey: "k", sheetId: "s", lock: PINNED, budgetUsed: 10, budgetLimit: 15000, connectionStatus: "ACTIVE" }),
    ).toEqual({ blockers: [], warnings: [] });
  });

  it("reports each blocker and the 80% budget warning", () => {
    const missing = preflightComposio({ apiKey: "", sheetId: "", lock: PINNED, budgetUsed: 0, budgetLimit: 15000, connectionStatus: "WAITING" });
    expect(missing.blockers).toContain("COMPOSIO_NOT_CONFIGURED");
    expect(missing.blockers).toContain("COMPOSIO_NOT_CONNECTED");
    expect(missing.blockers).toContain("SHEET_ID_INVALID");
    const unpinned = preflightComposio({ apiKey: "k", sheetId: "s", lock: loadToolLock(), budgetUsed: 0, budgetLimit: 15000, connectionStatus: "ACTIVE" });
    expect(unpinned.blockers).toContain("COMPOSIO_TOOL_MISSING");
    const broke = preflightComposio({ apiKey: "k", sheetId: "s", lock: PINNED, budgetUsed: 15000, budgetLimit: 15000, connectionStatus: "ACTIVE" });
    expect(broke.blockers).toContain("COMPOSIO_BUDGET_EXCEEDED");
    const warm = preflightComposio({ apiKey: "k", sheetId: "s", lock: PINNED, budgetUsed: 12000, budgetLimit: 15000, connectionStatus: "ACTIVE" });
    expect(warm.blockers).toEqual([]);
    expect(warm.warnings).toHaveLength(1);
  });
});
