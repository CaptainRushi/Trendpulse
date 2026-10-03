/**
 * GET /api/jev/health — key presence, last Jev call outcome, price and
 * spend. Spend is today's UTC Jev input cost vs the per-run budget knob
 * (no active run exists at request time, so the day total is the honest
 * number). Never throws: missing tables/columns degrade to zeros/null.
 */
import type { FastifyInstance } from "fastify";
import { JevHealthResponse } from "@trendpulse/shared";
import type { AppContext } from "./context.js";

function todaySpendUsd(ctx: AppContext): number {
  try {
    const row = ctx.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_calls WHERE client = 'jev' AND date(created_at) = date('now')",
      )
      .get() as { spent: number | null };
    return typeof row.spent === "number" ? row.spent : 0;
  } catch {
    return 0;
  }
}

function lastCallOk(ctx: AppContext): boolean | null {
  try {
    const row = ctx.db
      .prepare("SELECT status FROM llm_calls WHERE client = 'jev' ORDER BY id DESC LIMIT 1")
      .get() as { status: string } | undefined;
    if (!row) return null;
    return row.status === "ok";
  } catch {
    return null;
  }
}

export function registerJevHealth(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/jev/health", () => {
    return JevHealthResponse.parse({
      key_present: ctx.config.jevApiKey !== "",
      last_call_ok: lastCallOk(ctx),
      price_per_m_input: ctx.config.jevPricePerMInput,
      budget_used_usd: todaySpendUsd(ctx),
      budget_usd: ctx.config.jevRunBudgetUsd,
    });
  });
}
