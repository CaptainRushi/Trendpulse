/**
 * Setup probes (moved verbatim from app.ts in Phase 7 — behavior
 * unchanged): reachable without setup_complete, never echo keys.
 */
import type { FastifyInstance } from "fastify";
import { google } from "googleapis";
import { z } from "zod";
import { testJevConnection, testOmnirouteConnection } from "../llm/probe.js";
import { badRequest } from "./errors.js";
import type { AppContext } from "./context.js";
import { SHEETS_SCOPE } from "../sheets/auth.js";
import { createRealSheetsClient, GoogleSheetsClient } from "../sheets/realClient.js";
import { createGateway } from "../integrations/composio/gateway.js";

const TestOmnirouteBody = z.object({
  base_url: z.string().url(),
  api_key: z.string().optional(),
});

const TestJevBody = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().min(1),
});

const TestSheetsBody = z.object({
  sheet_id: z.string().optional(),
  service_account_json: z.string().optional(),
});

export function registerSetup(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/setup/test-omniroute", async (request) => {
    const parsed = TestOmnirouteBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("Invalid body: base_url must be a URL.");
    const result = await testOmnirouteConnection({
      baseUrl: parsed.data.base_url,
      apiKey: parsed.data.api_key,
    });
    if (!result.ok) return { ok: false, error: result.error, latency_ms: result.latencyMs };
    return { ok: true, models: result.models, latency_ms: result.latencyMs };
  });

  app.post("/api/setup/test-jev", async (request) => {
    const parsed = TestJevBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("Invalid body: model is required.");
    const result = await testJevConnection({
      baseUrl: parsed.data.base_url ?? "",
      apiKey: parsed.data.api_key,
      model: parsed.data.model,
      fallback:
        ctx.omnirouteBaseUrl !== undefined
          ? { baseUrl: ctx.omnirouteBaseUrl, apiKey: ctx.omnirouteApiKey ?? "" }
          : undefined,
    });
    if (!result.ok) return { ok: false, error: result.error, latency_ms: result.latencyMs };
    return {
      ok: true,
      model: result.model,
      latency_ms: result.latencyMs,
      ...(result.choice !== undefined ? { choice: result.choice, confidence: result.confidence } : {}),
    };
  });

  app.post("/api/setup/test-sheets", async (request) => {
    const parsed = TestSheetsBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("Invalid body.");
    try {
      const sheetId = parsed.data.sheet_id ?? ctx.config.googleSheetId;
      if (sheetId === "") {
        return { ok: false, error: "No sheet id: pass sheet_id or set GOOGLE_SHEET_ID." };
      }
      const provided = parsed.data.service_account_json;
      let email: string;
      let client;
      if (provided !== undefined) {
        let keyed: unknown;
        try {
          keyed = JSON.parse(provided) as unknown;
        } catch {
          return { ok: false, error: "service_account_json is not valid JSON." };
        }
        if (
          typeof keyed !== "object" ||
          keyed === null ||
          typeof (keyed as Record<string, unknown>)["client_email"] !== "string" ||
          typeof (keyed as Record<string, unknown>)["private_key"] !== "string"
        ) {
          return { ok: false, error: "service_account_json must be a service-account key object." };
        }
        const key = keyed as { client_email: string; private_key: string };
        const auth = new google.auth.JWT({
          email: key.client_email,
          key: key.private_key,
          scopes: [SHEETS_SCOPE],
        });
        client = new GoogleSheetsClient(google.sheets({ version: "v4", auth }));
        email = key.client_email;
      } else if (ctx.config.sheetsMode === "composio" || ctx.config.composioApiKey !== "") {
        // docs/15: composio mode is tested through the gateway, no key echo.
        const gateway = createGateway({
          apiKey: ctx.config.composioApiKey,
          userId: ctx.config.composioUserId,
          timeoutMs: ctx.config.composioCallTimeoutMs,
        });
        const info = await gateway.execute("spreadsheetInfo", { spreadsheet_id: sheetId });
        if (!info.ok) return { ok: false, error: info.error ?? "tool failed" };
        const data = info.data as { title?: string; tabs?: { title: string }[] } | undefined;
        return { ok: true, mode: "composio", title: data?.title ?? "", tabs: (data?.tabs ?? []).map((t) => t.title) };
      } else {
        const bundle = createRealSheetsClient(ctx.config.googleServiceAccountJsonPath);
        client = bundle.client;
        email = bundle.serviceAccountEmail;
      }
      const tabs = await client.getTabTitles(sheetId);
      return { ok: true, service_account_email: email, tabs };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
