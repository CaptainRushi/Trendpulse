/**
 * Run estimate (Doc 17 S2.3): what a category run would cost before it runs.
 * New-item counts are a documented heuristic (typical category yield), not a
 * measurement — the route says so. Stored reuse is exact (SQLite count).
 */
import type { StateDb } from "../db/sqlite.js";
import { CATEGORY_MAX_ITEMS } from "./collect.js";
import { effectiveSources, normalizeScope } from "./registry.js";
import type { CategorySource } from "./registry.js";

/** Rough input tokens per Jev call, for the cost guess only. */
const TOKENS_PER_JEV_CALL = 1500;

export interface EstimateInput {
  categories: string[];
  mode: "strict" | "loose";
  overrides?: Record<string, CategorySource[]>;
  redditCreds: boolean;
  /** Per-source take limit; defaults to the collector cap. */
  limit?: number;
}

export interface RunEstimate {
  scope: string;
  mode: "strict" | "loose";
  sources: { collector: string; categories: string[] }[];
  expected_new_items: number;
  stored_items_reused: number;
  jev_calls_expected: number;
  cost_usd_estimate: number;
  warnings: string[];
  heuristic: true;
}

export function estimateRun(
  db: StateDb,
  input: EstimateInput,
  today: string,
  pricePerMInput: number,
): RunEstimate {
  const scope = normalizeScope(input.categories);
  const warnings: string[] = [];
  const byCollector = new Map<string, { collector: string; categories: string[] }>();
  const perSource = Math.min(input.limit ?? CATEGORY_MAX_ITEMS, CATEGORY_MAX_ITEMS);
  let expected = 0;
  if (scope === "all") {
    warnings.push("no categories selected — estimates a general run");
  } else {
    for (const slug of scope.split("+")) {
      const sources = effectiveSources(slug, input.overrides);
      if (sources.length === 0) {
        warnings.push(`category '${slug}' has no sources — reuses stored items only`);
        continue;
      }
      for (const source of sources) {
        if (source.collector === "reddit" && !input.redditCreds) {
          warnings.push("reddit skipped without OAuth (no calls made)");
          continue;
        }
        const entry = byCollector.get(source.collector) ?? { collector: source.collector, categories: [] };
        if (!entry.categories.includes(slug)) entry.categories.push(slug);
        byCollector.set(source.collector, entry);
        expected += perSource;
      }
    }
  }
  const stored = (
    db.prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_date = ?").get(today) as { n: number }
  ).n;
  // Worst case: every new item needs a Jev call; the label cache only reduces.
  const jevCalls = expected;
  return {
    scope,
    mode: input.mode,
    sources: [...byCollector.values()],
    expected_new_items: expected,
    stored_items_reused: stored,
    jev_calls_expected: jevCalls,
    cost_usd_estimate: Math.round(((jevCalls * TOKENS_PER_JEV_CALL) / 1_000_000) * pricePerMInput * 10000) / 10000,
    warnings,
    heuristic: true,
  };
}
