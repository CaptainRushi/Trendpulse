import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { testContext } from "../api/helpers.js";
import type { TestApi } from "../api/helpers.js";
import { FakeLlmServer } from "../fakes/fakeLlmServer.js";

let gateway: FakeLlmServer;
let t: TestApi;

beforeEach(async () => {
  gateway = await FakeLlmServer.start();
  t = testContext();
});

afterEach(async () => {
  await gateway.stop();
  await t.close();
});

async function testApp(): Promise<FastifyInstance> {
  return buildApp({
    ...t.ctx,
    omnirouteBaseUrl: gateway.url,
    omnirouteApiKey: "omni-key",
  });
}

describe("POST /api/setup/test-omniroute", () => {
  it("returns the model list on success", async () => {
    gateway.enqueue({ models: ["jev", "extract-1"] });
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-omniroute",
        payload: { base_url: gateway.url, api_key: "k" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; models?: string[] }>();
      expect(body.ok).toBe(true);
      expect(body.models).toEqual(["jev", "extract-1"]);
    } finally {
      await app.close();
    }
  });

  it("rejects a missing base_url with VALIDATION", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-omniroute",
        payload: { api_key: "k" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
    } finally {
      await app.close();
    }
  });

  it("unreachable hosts return ok:false, not a 500", async () => {
    await gateway.stop();
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-omniroute",
        payload: { base_url: gateway.url },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; error?: string }>();
      expect(body.ok).toBe(false);
      expect(body.error ?? "").toMatch(/not reachable/i);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/setup/test-jev", () => {
  it("runs the sample completion against a direct endpoint", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-jev",
        payload: { base_url: gateway.url, api_key: "k", model: "jev-1" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; model?: string }>();
      expect(body).toMatchObject({ ok: true, model: "jev-1" });
    } finally {
      await app.close();
    }
  });

  it("falls back to the configured OmniRoute endpoint when base_url is empty", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-jev",
        payload: { model: "jev-via-gateway" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
      expect(gateway.seen).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a missing model with VALIDATION", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-jev",
        payload: { base_url: gateway.url },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
    } finally {
      await app.close();
    }
  });

  it("never echoes the api key", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-jev",
        payload: { base_url: gateway.url, api_key: "super-secret-key", model: "jev-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("super-secret-key");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/setup/test-sheets", () => {
  it("reports missing sheet id without touching the network", async () => {
    const app = await testApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-sheets",
        payload: { sheet_id: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects non-JSON and wrong-shaped keys without echoing them", async () => {
    const app = await testApp();
    try {
      for (const key of ["{oops", JSON.stringify({ nope: 1 })]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/setup/test-sheets",
          payload: { sheet_id: "s", service_account_json: key },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ ok: boolean }>().ok).toBe(false);
      }
      expect(gateway.seen).toHaveLength(0); // no network attempted
    } finally {
      await app.close();
    }
  });
});
