/**
 * Sheet admin: init tabs, clear the read cache, shareable links.
 * All three require a configured sheet id (SETUP_INCOMPLETE otherwise).
 */
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import type { AppContext } from "./context.js";
import { appRepo } from "./context.js";

function requireSheetId(ctx: AppContext): string {
  if (ctx.config.googleSheetId === "") {
    throw new ApiError(
      400,
      "SETUP_INCOMPLETE",
      "Google Sheet is not configured.",
      "Set GOOGLE_SHEET_ID and share the sheet with the service-account email as Editor.",
    );
  }
  return ctx.config.googleSheetId;
}

export function registerSheets(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/sheets/init", async () => {
    requireSheetId(ctx);
    return appRepo(ctx).init();
  });

  app.post("/api/sheets/sync", async () => {
    requireSheetId(ctx);
    await appRepo(ctx).sync();
    return { ok: true };
  });

  app.get("/api/sheets/link", () => {
    const sheetId = requireSheetId(ctx);
    // The API never learns tab gids — links land on the spreadsheet root
    // and the dashboard deep-links tabs client-side.
    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    return {
      spreadsheet_url: spreadsheetUrl,
      tabs: { raw_trends: spreadsheetUrl, sorted_trends: spreadsheetUrl },
    };
  });
}
