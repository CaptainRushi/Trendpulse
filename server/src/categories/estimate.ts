/**
 * Run estimate (Doc 17 S2.3, Doc 19 Q2): what a category run would cost
 * before it runs. New-item counts are a documented heuristic (per-source
 * cap, not a measurement) — the route says so. Stored reuse is exact
 * (SQLite count); Jev calls are cache-aware when the model + question
 * version are known (unlabeled stored items cost a call, labeled ones do
 * not); the writer runs only for each category's top clusters.
 */
import type { StateDb } from "../db/sqlite.js";
import { SourceKey } from "../sheets/schema.js";
import { CATEGORY_MAX_ITEMS } from "./collect.js";
import { effectiveSources } from "./registry.js";
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
  /** Jev model id for the label-cache check (omit = stored assumed labeled). */
  jevModel?: string;
  /** Question-set version for the label-cache check. */
  questionVersion?: string;
  /** TOP_PER_CATEGORY for the writer-top-clusters math. */
  topPerCategory?: number;
  /** Writer batch size for the writer-calls math. */
  batchSize?: number;
  /** INCLUDE_GENERAL_SOURCES: general collectors join the run. */
  includeGeneralSources?: boolean;
  /** Enabled general sources (used only with includeGeneralSources). */
  generalSources?: string[];
}

export interface CategoryEstimate {
  category: string;
  sources: string[];
  expected_new_items: number;
  stored_items_reused: number;
  jev_calls_expected: number;
  writer_clusters_expected: number;
}

export interface RunEstimate {
  scope: string;
  mode: "strict" | "loose";
  sources: { collector: string; categories: string[] }[];
  expected_new_items: number;
  stored_items_reused: number;
  jev_calls_expected: number;
  writer_calls_expected: number;
  cost_usd_estimate: number;
  warnings: string[];
  heuristic: true;
  per_category: CategoryEstimate[];
  general: { included: boolean; sources: string[]; expected_new_items: number; jev_calls_expected: number };
}

/** Enabled general sources: settings table, else every known collector. */
export function defaultEnabledGeneralSources(db: StateDb): string[] {
  try {
    const rows = db.prepare("SELECT key, enabled FROM sources").all() as { key: string; enabled: number }[];
    if (rows.length > 0) return rows.filter((row) => row.enabled !== 0).map((row) => row.key);
  } catch {
    // No sources table yet (bare test DB): fall through to all collectors.
  }
  return [...SourceKey.options];
}

function unlabeledStored(db: StateDb, runDate: string, target: string | null, jevModel: string, questionVersion: string): number {
  const row = (
    target === null
      ? db.prepare(
          "SELECT COUNT(*) AS n FROM items_run ir WHERE ir.run_date = ? AND ir.target_category IS NULL " +
            "AND NOT EXISTS (SELECT 1 FROM item_labels il WHERE il.item_id = ir.id AND il.model = ? AND il.question_set_version = ?)",
        ).get(runDate, jevModel, questionVersion)
      : db.prepare(
          "SELECT COUNT(*) AS n FROM items_run ir WHERE ir.run_date = ? AND ir.target_category = ? " +
            "AND NOT EXISTS (SELECT 1 FROM item_labels il WHERE il.item_id = ir.id AND il.model = ? AND il.question_set_version = ?)",
        ).get(runDate, target, jevModel, questionVersion)
  ) as { n: number };
  return row.n;
}

export function estimateRun(
  db: StateDb,
  input: EstimateInput,
  today: string,
  pricePerMInput: number,
): RunEstimate {
  const slugs = [...input.categories].sort();
  const scope = slugs.length === 0 ? "all" : slugs.join("+");
  const warnings: string[] = [];
  const byCollector = new Map<string, { collector: string; categories: string[] }>();
  const perSource = Math.min(input.limit ?? CATEGORY_MAX_ITEMS, CATEGORY_MAX_ITEMS);
  const top = input.topPerCategory ?? 5;
  const batch = Math.max(1, input.batchSize ?? 30);
  const cacheAware = input.jevModel !== undefined && input.questionVersion !== undefined;
  const perCategory: CategoryEstimate[] = [];
  let expected = 0;
  let storedTotal = 0;
  let jevTotal = 0;
  let writerClustersTotal = 0;
  for (const slug of slugs) {
    const usable = effectiveSources(slug, input.overrides).filter(
      (source) => source.collector !== "reddit" || input.redditCreds,
    );
    if (usable.length === 0) {
      warnings.push(`category '${slug}' has no sources — reuses stored items only`);
    }
    for (const source of usable) {
      const entry = byCollector.get(source.collector) ?? { collector: source.collector, categories: [] };
      if (!entry.categories.includes(slug)) entry.categories.push(slug);
      byCollector.set(source.collector, entry);
    }
    const expectedNew = usable.length * perSource;
    const storedRow = db
      .prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_date = ? AND target_category = ?")
      .get(today, slug) as { n: number };
    const stored = storedRow.n;
    const unlabeled = cacheAware
      ? unlabeledStored(db, today, slug, input.jevModel as string, input.questionVersion as string)
      : 0;
    const jev = expectedNew + unlabeled;
    // Score first, write later: the writer sees at most the top clusters.
    const available = expectedNew + Math.min(stored, top);
    const writerClusters = available === 0 ? 0 : Math.min(top, available);
    perCategory.push({
      category: slug,
      sources: usable.map((source) => source.collector),
      expected_new_items: expectedNew,
      stored_items_reused: stored,
      jev_calls_expected: jev,
      writer_clusters_expected: writerClusters,
    });
    expected += expectedNew;
    storedTotal += stored;
    jevTotal += jev;
    writerClustersTotal += writerClusters;
  }
  const general = { included: false, sources: [] as string[], expected_new_items: 0, jev_calls_expected: 0 };
  if (input.includeGeneralSources === true && slugs.length > 0) {
    general.included = true;
    general.sources = input.generalSources ?? defaultEnabledGeneralSources(db);
    general.expected_new_items = general.sources.length * perSource;
    general.jev_calls_expected = general.expected_new_items;
    expected += general.expected_new_items;
    jevTotal += general.jev_calls_expected;
    warnings.push(
      `INCLUDE_GENERAL_SOURCES is on: ${String(general.sources.length)} general sources add ~${String(general.expected_new_items)} items and ~${String(general.jev_calls_expected)} Jev calls`,
    );
  }
  const writerCalls = writerClustersTotal === 0 ? 0 : Math.ceil(writerClustersTotal / batch);
  return {
    scope,
    mode: input.mode,
    sources: [...byCollector.values()],
    expected_new_items: expected,
    stored_items_reused: storedTotal,
    jev_calls_expected: jevTotal,
    writer_calls_expected: writerCalls,
    cost_usd_estimate: Math.round(((jevTotal * TOKENS_PER_JEV_CALL) / 1_000_000) * pricePerMInput * 10000) / 10000,
    warnings,
    heuristic: true,
    per_category: perCategory,
    general,
  };
}
