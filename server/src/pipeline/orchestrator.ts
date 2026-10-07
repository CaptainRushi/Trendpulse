/**
 * Pipeline orchestrator (TRD §6): stage runner with `run_stages`
 * checkpoints, resume/retry, re-sort-only runs, lock + heartbeat, and
 * `runs_log` finalization.
 *
 * Checkpoint granularity is the TRD stage list. normalize/dedupe/
 * engagement_norm are checked off together — prepareRunItems performs all
 * three atomically in one transaction, so finer checkpoints would add rows
 * without adding resumability.
 *
 * Resume rule: re-execution starts at the first non-`done` requested stage.
 * Stages are written defensively (persist paths reconcile by run_id), so a
 * retry after a crash appends nothing twice. Retrying from a stage at or
 * before persist_raw while persisted rows exist is refused loudly — those
 * rows already correspond to sheet content under new ULIDs on re-prepare.
 *
 * Error rule: operational failures (Sheets/LLM typed errors) mark the stage
 * and run failed, then rethrow. Anything else propagates untouched — the
 * stage stays `running`, the run stays `running`, and a later retry resumes
 * from it (this is the kill -9 path: no checkpoint was reached).
 */
import type { Logger } from "pino";
import { HttpClient } from "../collectors/http.js";
import { runCollectors } from "../collectors/registry.js";
import { scrapingClient } from "../scraping/supervisor.js";
import type { CollectContext, RawItemDraft, SourceStats } from "../collectors/types.js";
import { createLogger } from "../utils/logger.js";
import { DomainRateLimiter } from "../utils/rate-limit.js";
import { ulid } from "../utils/ulid.js";
import type { TrendPulseConfig } from "../config/env.js";
import { resolveEffectiveSettings } from "../config/settings.js";
import type { EffectiveSettings } from "../config/settings.js";
import { pipelineBus } from "./events.js";
import type { EventBus } from "./events.js";
import { effectiveSources, validateMyCategories } from "../categories/registry.js";
import { CATEGORY_MAX_ITEMS, categoryOverrides, collectCategory } from "../categories/collect.js";
import {
  effectiveIncludeGeneralSources,
  effectiveMaxCategories,
  effectiveTopPerCategory,
  readMyCategories,
} from "../config/settings.js";
import { chunkBatch, cutTitle, emitSortEvent } from "./sortEvents.js";
import type { SortPhase } from "./sortEvents.js";
import type { StateDb } from "../db/sqlite.js";
import { createExtractor, type LlmExtractor } from "../llm/extract.js";
import { createExtractorClient } from "../llm/factory.js";
import { recordLlmCall } from "../llm/log.js";
import { LlmClient, LlmHttpError, LlmTimeoutError, LlmValidationError } from "../llm/client.js";
import { JevBudgetExceeded, JevClient, JevHttpError, JevTimeoutError, JevValidationError } from "../llm/jev.js";
import type { Classifier } from "../llm/classifier.js";
import { FallbackClassifier, JevClassifier } from "../llm/classifier.js";
import { classifyItems } from "../sorting/classifyLabels.js";
import type { ItemLabelRecord } from "../sorting/classifyLabels.js";
import { QUESTION_SET_VERSION } from "../sorting/questions.js";
import { readCachedLabels } from "../llm/labelCache.js";
import { assignCategory, ASSIGN_CONFIDENCE_MIN } from "../sorting/assign.js";
import type { Assignment } from "../sorting/assign.js";
import { aggregateClusters } from "../sorting/aggregate.js";
import type { AggregatedCluster } from "../sorting/aggregate.js";
import { clusterItems } from "../sorting/clusterTopics.js";
import type { SameStoryCheck, TopicCluster } from "../sorting/clusterTopics.js";
import { generateDigest } from "../sorting/digest.js";
import { toWriterInputs } from "../sorting/sortRun.js";
import { fallbackTopic, writeTopics } from "../sorting/writeTopics.js";
import type { WrittenTopic, WriteStats } from "../sorting/writeTopics.js";
import { SheetsApiError } from "../sheets/client.js";
import { createRealSheetsClient } from "../sheets/realClient.js";
import type { SheetsClient } from "../sheets/client.js";
import { SheetsRepo } from "../sheets/repo.js";
import type { SheetsWriteQueue } from "../sheets/queue.js";
import { DigestRecord, RunLogRecord, SourceKey } from "../sheets/schema.js";
import type { RawTrendRecord, SortedTrendRecord } from "../sheets/schema.js";
import { scoreTopics } from "../sorting/score.js";
import type { JevTopic } from "../sorting/score.js";
import { APP_VERSION } from "../version.js";
import {
  acquirePipelineLock,
  heartbeatPipelineLock,
  LOCK_HEARTBEAT_MS,
  releasePipelineLock,
} from "../scheduler/lock.js";
import {
  persistRawItems,
  prepareRunItems,
  readRunItems,
  readRunItemsByDate,
} from "./persist.js";

export const STAGES = [
  "collect",
  "normalize",
  "dedupe",
  "select",
  "sort_classify",
  "sort_assign",
  "sort_cluster",
  "score",
  "sort_write",
  "persist_sorted",
  "finalize",
] as const;
export type StageName = (typeof STAGES)[number];

const SORT_STAGES: StageName[] = ["select", "sort_classify", "sort_assign",
  "sort_cluster", "score", "sort_write", "persist_sorted", "finalize"];

/** Animation phase per sort stage (persist_sorted closes with "done"). */
const SORT_PHASES: Partial<Record<StageName, SortPhase>> = {
  sort_classify: "classify",
  sort_assign: "filter",
  sort_cluster: "cluster",
  sort_write: "write",
  score: "rank",
};
const PRE_PERSIST: StageName[] = ["collect", "normalize", "dedupe", "select"];

export type RunTrigger = "cron" | "manual" | "catchup";

/** Operator errors: bad run id, wrong state, bad stage selection (HTTP 400/404). */
export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

/** Operator errors: valid run, invalid request (HTTP 400). */
export class RunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRequestError";
  }
}

/** Nothing to work with: every source errored/blocked, zero drafts. */
export class NoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoDataError";
  }
}

export interface OrchestratorDeps {
  db: StateDb;
  config: TrendPulseConfig;
  log?: Logger;
  events?: EventBus;
  /** Lazy default: real service-account client (built per run, never at boot). */
  sheetsClient?: SheetsClient;
  /** Write queue for the Sheets repo. Default: production gap; tests pass a fast one. */
  sheetsQueue?: SheetsWriteQueue;
  /** Test seam: stub fetch for collectors. */
  fetchImpl?: typeof fetch;
  /** Sorter override: typed classifier (default: live Jev with budget + ledger). */
  classifier?: Classifier;
  /** Sorter override: fallback classifier (default: OmniRoute fallback model). */
  fallbackClassifier?: Classifier;
  /** Sorter override: Jev client for same_story pair checks. */
  pairJevClient?: JevClient;
  /** Sorter override: writer client (default: OmniRoute writer model). */
  writerClient?: LlmClient;
  /** Webpage extractor. Default: real extractor client (rejects without a key). */
  extractor?: LlmExtractor;
}

export interface StartRunOptions {
  trigger: RunTrigger;
  runDate?: string;
  stages?: StageName[];
  sources?: SourceKey[];
  /** Override every source limit (CLI --limit). */
  limit?: number;
  /** Route-generated id for 202-before-completion (default: fresh ULID). */
  runId?: string;
  /** Category slugs for a targeted run ([] = all). */
  categories?: string[];
  /** Focus mode for category runs (default strict). */
  mode?: "strict" | "loose";
}

export interface RunSummary {
  runId: string;
  runDate: string;
  status: string;
  itemsCollected: number;
  itemsNew: number;
  topicsCount: number;
}

/** Categories stored on pre-scope runs may be anything; clean to slugs. */
function parseCategoriesJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

interface Execution {
  runId: string;
  runDate: string;
  trigger: RunTrigger;
  requested: StageName[];
  sources: SourceKey[];
  limitOverride?: number;
  settings: EffectiveSettings;
  /** Drafts; category runs tag target_category (carried into items_run). */
  drafts: (RawItemDraft & { target_category?: string | null })[];
  sourceStats: SourceStats[];
  partialReasons: string[];
  scope: string;
  categories: string[];
  focusMode: "strict" | "loose";
}

function isOperationalError(error: unknown): boolean {
  return (
    error instanceof SheetsApiError ||
    error instanceof LlmValidationError ||
    error instanceof LlmHttpError ||
    error instanceof LlmTimeoutError ||
    error instanceof JevValidationError ||
    error instanceof JevHttpError ||
    error instanceof JevTimeoutError ||
    error instanceof SheetsApiError ||
    error instanceof LlmValidationError ||
    error instanceof LlmHttpError ||
    error instanceof LlmTimeoutError ||
    error instanceof JevValidationError ||
    error instanceof JevHttpError ||
    error instanceof JevTimeoutError ||
    error instanceof JevBudgetExceeded ||
    error instanceof NoDataError
  );
}

/** Cluster sharing the most evidence with a scored topic (for sort_rank). */
function bestCluster(evidenceIds: string[], clusters: { clusterId: string; itemIds: string[] }[]): string {
  const evidence = new Set(evidenceIds);
  let best = "";
  let bestOverlap = 0;
  for (const cluster of clusters) {
    const overlap = cluster.itemIds.filter((id) => evidence.has(id)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = cluster.clusterId;
    }
  }
  return best !== "" ? best : (clusters[0]?.clusterId ?? "");
}

export class Orchestrator {
  private readonly db: StateDb;
  private readonly config: TrendPulseConfig;
  private readonly log: Logger;
  private readonly events: EventBus;
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.log = deps.log ?? createLogger(deps.config.logLevel);
    this.events = deps.events ?? pipelineBus;
    this.deps = deps;
  }

  // ── run lifecycle ──────────────────────────────────────────────────────

  /** Fresh run through the requested stages (default: all ten). */
  async startRun(options: StartRunOptions): Promise<RunSummary> {
    return this.startRunBackground(options).done;
  }

  /**
   * Synchronous setup (validation, lock, run row) + deferred execution.
   * LockBusyError throws synchronously so POST /runs can answer 409
   * before sending 202; stage failures surface via `done`.
   */
  startRunBackground(options: StartRunOptions): { runId: string; done: Promise<RunSummary> } {
    const requested = options.stages ?? [...STAGES];
    if (requested.length === 0) throw new RunRequestError("at least one stage must be requested");
    for (const stage of requested) {
      if (!(STAGES as readonly string[]).includes(stage)) {
        throw new RunRequestError(`unknown stage '${stage}' (stages: ${STAGES.join(", ")})`);
      }
    }
    const runId = options.runId ?? ulid();
    const runDate = options.runDate ?? new Date().toLocaleDateString("en-CA", { timeZone: this.config.tz });
    // Doc 19: runs are category-driven. Explicit categories win; explicit
    // general sources (no categories) stay a general run for manual/stage
    // use; otherwise the run covers my_categories, and an empty selection
    // blocks before the lock + run row.
    const explicitCats = options.categories !== undefined && options.categories.length > 0;
    let categories: string[];
    if (explicitCats) {
      try {
        categories = validateMyCategories(options.categories, effectiveMaxCategories(this.db, this.config));
      } catch (error) {
        throw new RunRequestError(error instanceof Error ? error.message : "invalid categories");
      }
    } else if (options.sources !== undefined) {
      categories = [];
    } else {
      categories = readMyCategories(this.db);
      if (categories.length === 0) {
        throw new RunRequestError("NO_CATEGORIES_SELECTED: pick at least one category before running");
      }
    }
    // Scope is Doc-17 compat (scope_key + downstream stages) until Q3
    // removes it; categories carry the order my_categories defines.
    const scope = categories.length === 0 ? "all" : [...categories].sort().join("+");
    const focusMode = options.mode ?? "strict";
    // Before the lock + run row: failures here leave nothing behind.
    if (scope !== "all" && !this.hasUsableCategorySources(categories)) {
      throw new RunRequestError(`CATEGORY_NO_SOURCES: none of [${categories.join(", ")}] has a usable source (reddit needs OAuth)`);
    }
    acquirePipelineLock(this.db, runId);
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at, scope_key, focus_mode, categories_json)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(runId, runDate, options.trigger, JSON.stringify(requested), startedAt, scope, focusMode, JSON.stringify(categories));
    for (const stage of requested) {
      this.setStage(runId, stage, "pending");
    }
    const { settings, warnings } = resolveEffectiveSettings(this.db, this.config);
    for (const warning of warnings) this.log.warn({ runId }, warning);
    this.ensureSources();
    const sources = options.sources ?? this.enabledSources();
    if (sources.length === 0) {
      releasePipelineLock(this.db, runId);
      throw new RunRequestError("no enabled sources (see sources table)");
    }
    const exec: Execution = {
      runId,
      runDate,
      trigger: options.trigger,
      requested,
      sources,
      settings,
      drafts: [],
      sourceStats: [],
      partialReasons: [...warnings],
      scope,
      categories,
      focusMode,
    };
    if (options.limit !== undefined) exec.limitOverride = options.limit;
    const first = requested[0];
    if (!first) throw new RunRequestError("at least one stage must be requested");
    const done = this.runLocked(exec, first);
    return { runId, done };
  }

  private async runLocked(exec: Execution, from: StageName): Promise<RunSummary> {
    const heartbeat = setInterval(() => {
      heartbeatPipelineLock(this.db, exec.runId);
    }, LOCK_HEARTBEAT_MS);
    try {
      await this.executeFrom(exec, from);
      return this.finishRun(exec);
    } catch (error) {
      // finishFailed checkpoints the failure for operational errors;
      // unexpected errors propagate with stage/run left running.
      if (isOperationalError(error)) return this.finishFailed(exec.runId, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      releasePipelineLock(this.db, exec.runId);
    }
  }

  /**
   * Resume an interrupted/failed run from its first non-done requested
   * stage (or an explicit earlier stage). Refuses to rewind at or before
   * select once rows are persisted — those already map to sheet
   * content and re-preparing would mint new ULIDs for the same stories.
   */
  async retryRun(runId: string, fromStage?: StageName): Promise<RunSummary> {
    return this.retryRunBackground(runId, fromStage).done;
  }

  /** Synchronous setup + deferred resume (same 202/409 contract as start). */
  retryRunBackground(runId: string, fromStage?: StageName): { runId: string; done: Promise<RunSummary> } {
    const row = this.db.prepare("SELECT id, run_date, trigger, status, stages_requested, scope_key, focus_mode, categories_json FROM runs WHERE id = ?").get(runId) as
      | { id: string; run_date: string; trigger: RunTrigger; status: string; stages_requested: string; scope_key: string; focus_mode: string; categories_json: string }
      | undefined;
    if (!row) throw new RunNotFoundError(runId);
    const requested = JSON.parse(row.stages_requested) as StageName[];
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new RunRequestError(`run ${runId} has no pipeline stages (not an orchestrator run?)`);
    }
    if (row.status !== "failed" && row.status !== "interrupted") {
      throw new RunRequestError(`run ${runId} is ${row.status} — only failed/interrupted runs resume`);
    }
    acquirePipelineLock(this.db, runId);
    const statuses = this.stageStatuses(runId);
    const firstOpen = requested.find((stage) => statuses.get(stage) !== "done");
    const from = fromStage ?? firstOpen;
    if (!from) {
      releasePipelineLock(this.db, runId);
      throw new RunRequestError(`run ${runId} has nothing to resume (all stages done)`);
    }
    if (!requested.includes(from)) {
      releasePipelineLock(this.db, runId);
      throw new RunRequestError(`stage '${from}' was not requested by run ${runId}`);
    }
    if (PRE_PERSIST.includes(from) && this.hasPersistedRows(runId)) {
      releasePipelineLock(this.db, runId);
      throw new RunRequestError(
        `run ${runId} already persisted rows — resume from sort_classify or later, or start a new run`,
      );
    }
    // Rewind from..end to pending; earlier done stages stay done.
    const reset = this.db.prepare("UPDATE run_stages SET status = 'pending' WHERE run_id = ? AND stage = ?");
    let rewinding = false;
    for (const stage of requested) {
      if (stage === from) rewinding = true;
      if (rewinding) reset.run(runId, stage);
    }
    this.db.prepare("UPDATE runs SET status = 'running', error = NULL WHERE id = ?").run(runId);
    const { settings, warnings } = resolveEffectiveSettings(this.db, this.config);
    for (const warning of warnings) this.log.warn({ runId }, warning);
    this.ensureSources();
    const exec: Execution = {
      runId,
      runDate: row.run_date,
      trigger: row.trigger,
      requested,
      sources: this.enabledSources(),
      settings,
      drafts: [],
      sourceStats: this.loadSourceStats(runId),
      partialReasons: [...warnings],
      scope: row.scope_key || "all",
      categories: parseCategoriesJson(row.categories_json),
      focusMode: row.focus_mode === "loose" ? "loose" : "strict",
    };
    const done = this.runLocked(exec, from);
    return { runId, done };
  }

  /**
   * Re-sort-only: a fresh run over a date's persisted items (no collect,
   * no prepare — the working set already exists). Appends a new latest set
   * and flips the old one via markLatest. Categories pass through to
   * startRun (default: my_categories); explicit sources keep the legacy
   * general re-sort path.
   */
  async resortRun(
    runDate: string,
    options: { sources?: SourceKey[]; categories?: string[] } = {},
  ): Promise<RunSummary> {
    const items = readRunItemsByDate(this.db, runDate);
    if (items.length === 0) throw new RunRequestError(`no persisted items for date ${runDate} — nothing to re-sort`);
    const summary = await this.startRun({
      trigger: "manual",
      runDate,
      stages: [...SORT_STAGES],
      ...(options.sources ? { sources: options.sources } : {}),
      ...(options.categories ? { categories: options.categories } : {}),
    });
    return summary;
  }

  // ── execution ──────────────────────────────────────────────────────────

  private async executeFrom(exec: Execution, from: StageName): Promise<void> {
    const handlers: Record<StageName, () => Promise<void> | void> = {
      collect: () => this.stageCollect(exec),
      normalize: () => this.stagePrepare(exec),
      dedupe: () => {
        this.stageNoop(exec, "dedupe");
      },
      select: () => this.stageSelect(exec),
      sort_classify: () => this.stageSortClassify(exec),
      sort_assign: () => {
        this.stageSortAssign(exec);
      },
      sort_cluster: () => this.stageSortCluster(exec),
      score: () => {
        this.stageScore(exec);
      },
      sort_write: () => this.stageSortWrite(exec),
      persist_sorted: () => this.stagePersistSorted(exec),
      finalize: () => this.stageFinalize(exec),
    };
    let active = false;
    for (const stage of exec.requested) {
      if (stage === from) active = true;
      if (!active) continue;
      await this.runStage(exec, stage, handlers[stage]);
    }
  }

  /** Sort animation phase per stage (Doc 17 S4); persist_sorted closes it. */
  private async runStage(exec: Execution, stage: StageName, handler: () => Promise<void> | void): Promise<void> {
    this.setStage(exec.runId, stage, "running");
    this.events.emit(exec.runId, "stage", { stage, status: "running" });
    const phase = SORT_PHASES[stage];
    if (phase !== undefined) {
      emitSortEvent(this.db, this.events, exec.runId, "sort_phase", { phase });
    }
    this.events.emit(exec.runId, "progress", {
      stage,
      done: exec.requested.indexOf(stage),
      total: exec.requested.length,
    });
    try {
      await handler();
    } catch (error) {
      if (!isOperationalError(error)) throw error; // kill semantics: leave running
      const message = error instanceof Error ? error.message : String(error);
      this.setStage(exec.runId, stage, "failed", { error: message });
      this.events.emit(exec.runId, "stage", { stage, status: "failed", error: message });
      this.events.emit(exec.runId, "error", { stage, error: message });
      throw error;
    }
    this.setStage(exec.runId, stage, "done");
    this.events.emit(exec.runId, "stage", { stage, status: "done" });
    if (stage === "persist_sorted") {
      emitSortEvent(this.db, this.events, exec.runId, "sort_phase", { phase: "done" });
    }
  }

  /** normalize/dedupe/engagement_norm share prepareRunItems' atomic unit. */
  private stageNoop(exec: Execution, stage: StageName): void {
    this.setStageDetail(exec.runId, stage, { via: "prepareRunItems" });
  }

  // ── stages ─────────────────────────────────────────────────────────────

  /** Any effective source callable (reddit needs OAuth creds). */
  private hasUsableCategorySources(categories: string[]): boolean {
    const overrides = categoryOverrides(this.db);
    const creds = this.config.redditClientId !== "" && this.config.redditClientSecret !== "";
    return categories.some((slug) =>
      effectiveSources(slug, overrides).some((source) => source.collector !== "reddit" || creds),
    );
  }

  private async stageCollect(exec: Execution): Promise<void> {
    if (exec.scope !== "all") {
      await this.stageCollectCategory(exec);
      return;
    }
    const { limits, configs } = this.sourceLimitsConfigs(exec.sources, exec.limitOverride);
    const ctx = this.collectContext(exec.runId, exec.limitOverride);
    const out = await runCollectors(ctx, { keys: exec.sources, limits, configs });
    const finishedAt = new Date().toISOString();
    const insertStats = this.db.prepare(
      `INSERT OR REPLACE INTO run_source_stats (run_id, source, status, items, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const touchSource = this.db.prepare(
      `UPDATE sources SET last_status = ?, last_error = ?, last_run_at = ?, last_items = ? WHERE key = ?`,
    );
    for (const stat of out.stats) {
      insertStats.run(exec.runId, stat.source, stat.status, stat.items, stat.duration_ms, stat.error);
      touchSource.run(stat.status, stat.error, finishedAt, stat.items, stat.source);
      this.events.emit(exec.runId, "source", {
        source: stat.source,
        status: stat.status,
        items: stat.items,
        duration_ms: stat.duration_ms,
      });
      if (stat.status === "error" || stat.status === "blocked") {
        exec.partialReasons.push(`source ${stat.source}: ${stat.error ?? "unknown error"}`);
      }
    }
    this.db.prepare("UPDATE runs SET items_collected = ? WHERE id = ?").run(out.items.length, exec.runId);
    exec.drafts = out.items;
    exec.sourceStats = out.stats;
    this.setStageDetail(exec.runId, "collect", { keys: exec.sources });
  }

  /**
   * Category collect (Doc 19 Q2): only the run's registry sources run.
   * General sources join only with INCLUDE_GENERAL_SOURCES (stamped with a
   * null target). Each category is isolated: its failure is recorded in
   * category_runs and as a run warning, never stopping the others.
   * Today's stored items are assembled alongside so stored labels get
   * reused. Drafts carry target_category through normalize into items_run.
   */
  private async stageCollectCategory(exec: Execution): Promise<void> {
    const base = this.collectContext(exec.runId, exec.limitOverride);
    const overrides = categoryOverrides(this.db);
    const drafts: (RawItemDraft & { target_category?: string | null })[] = [];
    const stats: SourceStats[] = [];
    const redditCreds =
      this.config.redditClientId !== "" && this.config.redditClientSecret !== ""
        ? { reddit_client_id: this.config.redditClientId, reddit_client_secret: this.config.redditClientSecret }
        : {};
    const hasRedditCreds =
      "reddit_client_id" in redditCreds ||
      ((process.env["REDDIT_CLIENT_ID"] ?? "") !== "" && (process.env["REDDIT_CLIENT_SECRET"] ?? "") !== "");
    const markCategory = this.db.prepare(
      `INSERT INTO category_runs (run_id, category, status, items_collected, items_kept, topics, started_at, finished_at, error)
       VALUES (?, ?, 'running', 0, 0, 0, ?, NULL, NULL)
       ON CONFLICT(run_id, category) DO UPDATE SET status = 'running', started_at = excluded.started_at, finished_at = NULL, error = NULL`,
    );
    const finishCategory = this.db.prepare(
      "UPDATE category_runs SET status = ?, items_collected = ?, finished_at = ?, error = ? WHERE run_id = ? AND category = ?",
    );
    for (const slug of exec.categories) {
      const startedAt = new Date().toISOString();
      markCategory.run(exec.runId, slug, startedAt);
      let collected = 0;
      let catStatus = "ok";
      const sources = effectiveSources(slug, overrides);
      const usable = sources.filter((source) => source.collector !== "reddit" || hasRedditCreds);
      if (usable.length === 0) {
        const reason = `CATEGORY_NO_SOURCES: category '${slug}' has no usable source (reddit needs OAuth)`;
        finishCategory.run("no_sources", 0, new Date().toISOString(), reason, exec.runId, slug);
        exec.partialReasons.push(reason);
        catStatus = "no_sources";
      } else {
        try {
          const out = await collectCategory({ ...base, limit: CATEGORY_MAX_ITEMS }, slug, sources, CATEGORY_MAX_ITEMS, redditCreds);
          drafts.push(...out.items);
          stats.push(...out.stats);
          collected = out.items.length;
          for (const stat of out.stats) {
            this.events.emit(exec.runId, "source", {
              source: `${stat.source}:${slug}`,
              status: stat.status,
              items: stat.items,
              duration_ms: stat.duration_ms,
            });
          }
          const failed = out.stats.some((stat) => stat.status === "error" || stat.status === "blocked");
          if (out.items.length === 0 && failed) {
            const errs = out.stats
              .filter((stat) => stat.status === "error" || stat.status === "blocked")
              .map((stat) => `${stat.source}: ${stat.error ?? stat.status}`);
            const reason = `category '${slug}': ${errs.join("; ")}`;
            finishCategory.run("failed", 0, new Date().toISOString(), reason, exec.runId, slug);
            exec.partialReasons.push(reason);
            catStatus = "failed";
          } else {
            finishCategory.run("ok", out.items.length, new Date().toISOString(), null, exec.runId, slug);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finishCategory.run("failed", 0, new Date().toISOString(), message, exec.runId, slug);
          exec.partialReasons.push(`category '${slug}': ${message}`);
          catStatus = "failed";
        }
      }
      emitSortEvent(this.db, this.events, exec.runId, "category_status", {
        category: slug,
        phase: "collect",
        status: catStatus,
        items: collected,
      });
    }
    if (effectiveIncludeGeneralSources(this.db, this.config)) {
      try {
        const { limits, configs } = this.sourceLimitsConfigs(exec.sources, exec.limitOverride);
        const ctx = this.collectContext(exec.runId, exec.limitOverride);
        const out = await runCollectors(ctx, { keys: exec.sources, limits, configs });
        for (const item of out.items) drafts.push({ ...item, target_category: null });
        stats.push(...out.stats);
        for (const stat of out.stats) {
          this.events.emit(exec.runId, "source", {
            source: stat.source,
            status: stat.status,
            items: stat.items,
            duration_ms: stat.duration_ms,
          });
          if (stat.status === "error" || stat.status === "blocked") {
            exec.partialReasons.push(`source ${stat.source}: ${stat.error ?? "unknown error"}`);
          }
        }
      } catch (error) {
        exec.partialReasons.push(`general sources: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Assembly of today's stored items moved to the select stage (which
    // filters to cached labels in the selected categories); collect only
    // gathers fresh drafts here.
    const finishedAt = new Date().toISOString();
    const insertStats = this.db.prepare(
      `INSERT OR REPLACE INTO run_source_stats (run_id, source, status, items, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const touchSource = this.db.prepare(
      `UPDATE sources SET last_status = ?, last_error = ?, last_run_at = ?, last_items = ? WHERE key = ?`,
    );
    for (const stat of stats) {
      insertStats.run(exec.runId, stat.source, stat.status, stat.items, stat.duration_ms, stat.error);
      touchSource.run(stat.status, stat.error, finishedAt, stat.items, stat.source);
      if (stat.status === "error" || stat.status === "blocked") {
        exec.partialReasons.push(`source ${stat.source}: ${stat.error ?? "unknown error"}`);
      }
    }
    this.db.prepare("UPDATE runs SET items_collected = ? WHERE id = ?").run(drafts.length, exec.runId);
    exec.drafts = drafts;
    exec.sourceStats = stats;
    this.setStageDetail(exec.runId, "collect", { scope: exec.scope, categories: exec.categories });
  }

  private async stagePrepare(exec: Execution): Promise<void> {
    if (exec.drafts.length === 0) {
      const stats = exec.sourceStats.length > 0 ? exec.sourceStats : this.loadSourceStats(exec.runId);
      if (stats.length > 0 && !stats.some((stat) => stat.status === "ok")) {
        // Nothing was collected and nothing can be: fail here with the stage
        // name instead of dying later on an empty sheet tab. A quiet rerun
        // (drafts present but all seen) never lands here.
        throw new NoDataError(
          `no items collected (sources: ${stats.map((s) => `${s.source}=${s.status}`).join(", ")})`,
        );
      }
      // Resume path: collect already checkpointed — re-fetch (idempotent;
      // seen-filter + dedupe keep the working set stable).
      await this.stageCollect(exec);
      this.setStage(exec.runId, "collect", "done");
    }
    this.db.prepare("DELETE FROM items_run WHERE run_id = ? AND persisted = 0").run(exec.runId);
    const prepared = prepareRunItems(this.db, {
      runId: exec.runId,
      runDate: exec.runDate,
      drafts: exec.drafts,
      dedupeDays: exec.settings.dedupeDays,
    });
    this.db.prepare("UPDATE runs SET items_new = ? WHERE id = ?").run(prepared.stats.output, exec.runId);
    this.setStageDetail(exec.runId, "normalize", { stats: prepared.stats });
  }

  private repo(): SheetsRepo {
    let client: SheetsClient;
    try {
      client =
        this.deps.sheetsClient ?? createRealSheetsClient(this.config.googleServiceAccountJsonPath).client;
    } catch (error) {
      // Missing/unreadable credentials are operational (stage failed, run
      // failed) — never an "unexpected" error that leaves the run `running`.
      throw new SheetsApiError(error instanceof Error ? error.message : String(error), {});
    }
    return new SheetsRepo(client, {
      spreadsheetId: this.config.googleSheetId,
      cacheTtlS: this.config.sheetCacheTtlS,
      ...(this.deps.sheetsQueue ? { queue: this.deps.sheetsQueue } : {}),
    });
  }

  /**
   * Select (Doc 19 Q3): persist the new raw rows (old persist_raw body),
   * then assemble the sort working set — this run's new rows plus stored
   * rows that already carry a cached Jev label in a selected category.
   * Stored rows without a label are never classified (no Jev spend on
   * unselected categories). Nothing is inserted: the selection is a list
   * of ids, so reruns add ~0 rows and classify from cache.
   */
  private async stageSelect(exec: Execution): Promise<void> {
    const persisted = await persistRawItems(this.db, this.repo(), exec.runId, exec.runDate);
    const fresh = readRunItems(this.db, exec.runId).map((row) => row.id);
    const storedIds: string[] = [];
    let storedLabeled = 0;
    let storedUnlabeled = 0;
    if (exec.categories.length > 0) {
      const selected = new Set(exec.categories);
      const model = this.sorterClassifier(exec.runId).modelId;
      const candidates = readRunItemsByDate(this.db, exec.runDate).filter((row) => row.run_id !== exec.runId);
      for (const row of candidates) {
        const cached = readCachedLabels(this.db, row.id, QUESTION_SET_VERSION, model);
        const categoryAnswer = cached.find((entry) => entry.question === "category");
        if (!categoryAnswer) {
          storedUnlabeled += 1;
          continue;
        }
        let choice = "";
        try {
          const parsed = JSON.parse(categoryAnswer.answerJson) as { choice?: unknown };
          if (typeof parsed.choice === "string") choice = parsed.choice;
        } catch {
          choice = "";
        }
        if (choice !== "" && selected.has(choice.trim().toLowerCase())) {
          storedIds.push(row.id);
          storedLabeled += 1;
        }
      }
    }
    this.setStageDetail(exec.runId, "select", {
      persisted,
      newIds: fresh,
      storedIds,
      counts: { new: fresh.length, storedLabeled, storedUnlabeled },
    });
  }

  private sortItems(exec: Execution): RawTrendRecord[] {
    // Working set = this run's rows (or the date's set for re-sorts) plus
    // the select stage's stored picks. Falls back to the legacy read when
    // select never ran (partial stage lists).
    const resort = !exec.requested.includes("collect");
    const base = resort ? readRunItemsByDate(this.db, exec.runDate) : readRunItems(this.db, exec.runId);
    const detail = this.stageDetail(exec.runId, "select") as { storedIds?: unknown } | null;
    const storedIds = detail && Array.isArray(detail.storedIds)
      ? detail.storedIds.filter((id): id is string => typeof id === "string")
      : null;
    if (storedIds === null || storedIds.length === 0) return base;
    const have = new Set(base.map((row) => row.id));
    const extra = readRunItemsByDate(this.db, exec.runDate).filter((row) => storedIds.includes(row.id) && !have.has(row.id));
    return [...base, ...extra];
  }

  private async stageSortClassify(exec: Execution): Promise<void> {
    const items = this.sortItems(exec);
    const classifier = this.sorterClassifier(exec.runId);
    const fallback = this.sorterFallback(exec.runId);
    const { labeled, stats } = await classifyItems(
      {
        db: this.db,
        classifier,
        fallback,
        fallbackEnabled: this.config.jevFallback && fallback !== undefined,
        model: classifier.modelId,
        niches: this.config.niches,
      },
      items.map((item) => ({
        id: item.id,
        contentHash: item.content_hash,
        title: item.title,
        snippet: item.snippet,
        source: item.source,
        publishedAt: item.published_at,
      })),
    );
    const update = this.db.prepare("UPDATE items_run SET sort_status = ? WHERE id = ?");
    const write = this.db.transaction(() => {
      for (const entry of labeled) {
        if (entry.labels.quality < this.config.qualityMin) update.run("discarded", entry.itemId);
      }
    });
    write();
    if (stats.failed.length > 0) {
      const markFailed = this.db.prepare("UPDATE items_run SET sort_status = 'sort_failed' WHERE id = ?");
      const mark = this.db.transaction(() => {
        for (const id of stats.failed) markFailed.run(id);
      });
      mark();
      exec.partialReasons.push(`${String(stats.failed.length)} items unclassifiable (sort_failed)`);
    }
    if (stats.budgetStopped) exec.partialReasons.push("jev budget exhausted; unclassified items stay pending");
    this.setStageDetail(exec.runId, "sort_classify", {
      labels: labeled.map((entry) => ({ itemId: entry.itemId, labels: entry.labels })),
      discarded: labeled.filter((entry) => entry.labels.quality < this.config.qualityMin).map((entry) => entry.itemId),
      failedItemIds: stats.failed,
      classified: stats.classified,
      cached: stats.cached,
      fallbackWrites: stats.fallbackUsed,
      budgetStopped: stats.budgetStopped,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const batches = chunkBatch(labeled, 100);
    const cost = this.llmCost(exec.runId);
    batches.forEach((batch, i) => {
      emitSortEvent(this.db, this.events, exec.runId, "sort_batch", {
        stage: "classify",
        items: batch.map((entry) => ({
          id: entry.itemId,
          t: cutTitle(byId.get(entry.itemId)?.title ?? ""),
          c: entry.labels.category.toLowerCase(),
          q: entry.labels.quality,
          f: entry.labels.classifier === "fallback",
          d: entry.labels.quality < this.config.qualityMin,
          o: false,
        })),
        done: Math.min((i + 1) * 100, labeled.length),
        total: labeled.length,
        jev_calls: stats.classified,
        fallback_calls: stats.fallbackUsed,
        cost_usd: cost,
      });
    });
  }

  /** LLM spend so far this run (for the animation counters). */
  private llmCost(runId: string): number {
    try {
      const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM llm_calls WHERE run_id = ?").get(runId) as {
        n: number | null;
      };
      return row.n ?? 0;
    } catch {
      return 0;
    }
  }

  private loadClassifyDetail(exec: Execution): { labels: { itemId: string; labels: ItemLabelRecord["labels"] }[] } {
    const detail = this.stageDetail(exec.runId, "sort_classify") as { labels?: unknown } | null;
    if (!detail || !Array.isArray(detail.labels)) {
      throw new RunRequestError(`sort_classify output missing for run ${exec.runId} — run sort_classify first`);
    }
    return detail as { labels: { itemId: string; labels: ItemLabelRecord["labels"] }[] };
  }

  /**
   * Assign (Doc 19 Q3): every classified item lands in exactly one of the
   * run's categories, or is excluded (raw row kept, never deleted).
   * Confident (≥0.6) + selected → that category; confident + unselected →
   * off_category; below 0.6 → the source's target_category (or no
   * assignment without one). Exclusions live in the stage detail so
   * cluster stays deterministic on resume.
   */
  private stageSortAssign(exec: Execution): void {
    const classified = this.loadClassifyDetail(exec);
    const items = this.sortItems(exec);
    const byId = new Map(items.map((item) => [item.id, item]));
    const selected = new Set(exec.categories);
    const assignments: ({ itemId: string } & Assignment)[] = [];
    let assigned = 0;
    let offCategory = 0;
    let lowConfidenceByTarget = 0;
    for (const entry of classified.labels) {
      const item = byId.get(entry.itemId);
      const target = item?.target_category ?? null;
      const result = assignCategory({
        label: entry.labels.category,
        confidence: entry.labels.category_confidence,
        selected,
        target,
      });
      if ("category" in result) {
        assigned += 1;
        if (entry.labels.category_confidence < ASSIGN_CONFIDENCE_MIN) lowConfidenceByTarget += 1;
      } else if (result.excluded === "off_category") {
        offCategory += 1;
      }
      assignments.push({ itemId: entry.itemId, ...result });
    }
    this.setStageDetail(exec.runId, "sort_assign", {
      scope: exec.scope,
      categories: exec.categories,
      assignments,
      counts: { assigned, off_category: offCategory, low_confidence_by_target: lowConfidenceByTarget },
    });
    const excluded = assignments.filter((a) => "excluded" in a);
    if (excluded.length > 0) {
      emitSortEvent(this.db, this.events, exec.runId, "sort_batch", {
        stage: "assign",
        items: excluded.map((entry) => ({
          id: entry.itemId,
          t: "",
          c: "off_category",
          q: 0,
          f: false,
          d: false,
          o: true,
        })),
        done: excluded.length,
        total: excluded.length,
        jev_calls: 0,
        fallback_calls: 0,
        cost_usd: this.llmCost(exec.runId),
      });
    }
    for (const slug of exec.categories) {
      emitSortEvent(this.db, this.events, exec.runId, "category_status", {
        category: slug,
        phase: "assign",
        status: "done",
        assigned: assignments.filter((a) => "category" in a && a.category === slug).length,
      });
    }
  }

  private assignExcluded(exec: Execution): Set<string> {
    const detail = this.stageDetail(exec.runId, "sort_assign") as { assignments?: ({ itemId: string } & Assignment)[] } | null;
    if (!detail || !Array.isArray(detail.assignments)) return new Set();
    return new Set(detail.assignments.filter((entry) => "excluded" in entry).map((entry) => entry.itemId));
  }

  private async stageSortCluster(exec: Execution): Promise<void> {
    const classified = this.loadClassifyDetail(exec);
    const labelMap = new Map(classified.labels.map((entry) => [entry.itemId, entry.labels]));
    const excluded = this.assignExcluded(exec);
    const items = this.sortItems(exec).filter((item) => labelMap.has(item.id) && !excluded.has(item.id));
    const assigned = this.assignmentsByItem(exec);
    // Doc 19: cluster within each category only; cluster ids carry the partition.
    const byCategory = new Map<string, typeof items>();
    for (const item of items) {
      const slug = assigned.get(item.id);
      if (!slug) continue;
      const list = byCategory.get(slug) ?? [];
      list.push(item);
      byCategory.set(slug, list);
    }
    const clusters: TopicCluster[] = [];
    const aggregated: AggregatedCluster[] = [];
    const hashes = [...new Set(items.map((item) => item.content_hash))];
    const firstSeen = this.firstSeenByItem(items, hashes);
    for (const [slug, partition] of [...byCategory.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const part = await clusterItems(
        partition.map((item) => ({ id: item.id, title: item.title, snippet: item.snippet })),
        this.sameStoryOption(exec),
      );
      const aggregateById = new Map<string, { id: string; source: string; engagementNorm: number; firstSeenToday: boolean; labels: ItemLabelRecord["labels"] }>();
      for (const item of partition) {
        const labels = labelMap.get(item.id);
        if (!labels) continue;
        aggregateById.set(item.id, {
          id: item.id,
          source: item.source,
          engagementNorm: item.engagement_norm,
          firstSeenToday: firstSeen.get(item.id) === exec.runDate,
          labels,
        });
      }
      const partAggregated = aggregateClusters(part, aggregateById);
      part.forEach((cluster, i) => {
        clusters.push({ id: `${slug}:${cluster.id}`, itemIds: [...cluster.itemIds].sort() });
        const agg = partAggregated[i];
        if (agg) aggregated.push({ ...agg, clusterId: `${slug}:${cluster.id}` });
      });
    }
    this.setStageDetail(exec.runId, "sort_cluster", { clusters, aggregated });
    emitSortEvent(this.db, this.events, exec.runId, "sort_clusters", {
      clusters: clusters.map((cluster) => {
        const agg = aggregated.find((a) => a.clusterId === cluster.id);
        return {
          id: cluster.id,
          category: (agg?.category ?? "").toLowerCase(),
          size: cluster.itemIds.length,
          member_ids: cluster.itemIds.slice(0, 12),
        };
      }),
    });
  }

  /** Assigned category slug per item id (from the sort_assign detail). */
  private assignmentsByItem(exec: Execution): Map<string, string> {
    const detail = this.stageDetail(exec.runId, "sort_assign") as { assignments?: ({ itemId: string } & Assignment)[] } | null;
    const out = new Map<string, string>();
    if (!detail || !Array.isArray(detail.assignments)) return out;
    for (const entry of detail.assignments) {
      if ("category" in entry) out.set(entry.itemId, entry.category);
    }
    return out;
  }

  private sameStoryOption(exec: Execution): { sameStory?: SameStoryCheck | undefined } {
    const pairClient = this.sorterPairClient(exec.runId);
    if (!pairClient) return {};
    const sameStory: SameStoryCheck = async (a, b) => {
      try {
        const result = await pairClient.classify(
          { a: `${a.title} ${a.snippet}`.slice(0, 2000), b: `${b.title} ${b.snippet}`.slice(0, 2000) },
          { same_story: { type: "noul", instructions: "Are these two items about the same real-world story?" } },
          "jev_same_story",
        );
        const answer = result.answers["same_story"];
        return answer?.kind === "noul" ? answer.noul : null;
      } catch (error) {
        if (error instanceof JevBudgetExceeded) return null;
        throw error;
      }
    };
    return { sameStory };
  }

  private loadClusterDetail(exec: Execution): { clusters: TopicCluster[]; aggregated: AggregatedCluster[] } {
    const detail = this.stageDetail(exec.runId, "sort_cluster") as {
      clusters?: unknown;
      aggregated?: unknown;
    } | null;
    if (!detail || !Array.isArray(detail.clusters) || !Array.isArray(detail.aggregated)) {
      throw new RunRequestError(`sort_cluster output missing for run ${exec.runId} — run sort_cluster first`);
    }
    return detail as { clusters: TopicCluster[]; aggregated: AggregatedCluster[] };
  }

  private async stageSortWrite(exec: Execution): Promise<void> {
    const scoreDetail = this.stageDetail(exec.runId, "score") as { topClusters?: unknown } | null;
    const topClusters =
      scoreDetail && typeof scoreDetail.topClusters === "object" && scoreDetail.topClusters !== null
        ? (scoreDetail.topClusters as Record<string, string[]>)
        : null;
    if (!topClusters) {
      throw new RunRequestError(`score output missing for run ${exec.runId} — run score first`);
    }
    // Score first, write later: the writer sees only each category's top.
    const order: string[] = [];
    for (const slug of Object.keys(topClusters).sort()) {
      const ids = topClusters[slug];
      if (Array.isArray(ids)) order.push(...ids.filter((id): id is string => typeof id === "string"));
    }
    const { aggregated } = this.loadClusterDetail(exec);
    const byCluster = new Map(aggregated.map((agg) => [agg.clusterId, agg]));
    const filtered = order.map((id) => byCluster.get(id)).filter((agg): agg is AggregatedCluster => agg !== undefined);
    const items = this.sortItems(exec);
    const byId = new Map(items.map((item) => [item.id, item]));
    const inputs = toWriterInputs(filtered, byId);
    const onBatch = (batch: WrittenTopic[]): void => {
      emitSortEvent(this.db, this.events, exec.runId, "sort_topics", {
        topics: batch.map((w) => ({ cluster_id: w.text.cluster_id, title: cutTitle(w.text.title) })),
      });
    };
    let result: { topics: WrittenTopic[]; stats: WriteStats };
    try {
      result = await writeTopics(this.sorterWriter(exec.runId), inputs, {
        batchSize: exec.settings.sortBatchSize,
        onBatch,
      });
    } catch (error) {
      // Writer transport failure: fallback text for every top cluster, run survives.
      const fallen = inputs.map((cluster) => ({ text: fallbackTopic(cluster), writeFailed: true }));
      onBatch(fallen);
      result = {
        topics: fallen,
        stats: { batches: 0, repaired: 0, splits: 0, followUps: 0, fallbacks: fallen.length },
      };
      exec.partialReasons.push(
        `writer failed (${error instanceof Error ? error.message : String(error)}) — fallback text used`,
      );
    }
    const written: WrittenTopic[] = result.topics;
    const failedCards = written.filter((w) => w.writeFailed).length;
    if (failedCards > 0) {
      exec.partialReasons.push(`${String(failedCards)} topics use fallback text (write_failed)`);
    }
    this.setStageDetail(exec.runId, "sort_write", { written });
  }

  /**
   * Score before write (Doc 19 Q3): per-category placeholder scoring —
   * the formula is text-free (engagement, diversity, Jev ratings), so
   * clusters score on provisional top-item text and the writer later
   * patches the top clusters only. Ranks restart at 1 per category.
   */
  private stageScore(exec: Execution): void {
    const { aggregated } = this.loadClusterDetail(exec);
    const items = this.sortItems(exec);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const byId = itemsById;
    const hashes = [...new Set(items.map((item) => item.content_hash))];
    const firstSeenDates = this.firstSeenByItem(items, hashes);
    const top = effectiveTopPerCategory(this.db, this.config);
    const partitions = new Map<string, AggregatedCluster[]>();
    for (const agg of aggregated) {
      const slug = agg.clusterId.includes(":") ? (agg.clusterId.split(":")[0] as string) : agg.category.toLowerCase();
      const list = partitions.get(slug) ?? [];
      list.push(agg);
      partitions.set(slug, list);
    }
    const topics: SortedTrendRecord[] = [];
    const topClusters: Record<string, string[]> = {};
    let droppedNoEvidence = 0;
    let momentumCoerced = 0;
    for (const slug of [...partitions.keys()].sort()) {
      const part = partitions.get(slug) ?? [];
      const inputs: JevTopic[] = part.map((agg) => {
        const members = agg.itemIds
          .map((id) => byId.get(id))
          .filter((item): item is RawTrendRecord => item !== undefined)
          .sort((a, b) => b.engagement_norm - a.engagement_norm);
        const lead = members[0];
        return {
          title: (lead?.title ?? agg.clusterId).slice(0, 140),
          summary: (lead?.snippet ?? "").slice(0, 280),
          category: agg.category as JevTopic["category"],
          tags: [],
          relevance: Math.round(agg.relevance * 100),
          novelty: Math.round(agg.novelty * 100),
          momentum: agg.momentum,
          sentiment: agg.sentiment as JevTopic["sentiment"],
          why_trending: "",
          content_angles: ["", "", ""],
          item_ids: agg.itemIds,
        };
      });
      const scored = scoreTopics({
        topics: inputs,
        itemsById,
        runId: exec.runId,
        runDate: exec.runDate,
        jevModel: this.sorterClassifier(exec.runId).modelId,
        weights: exec.settings.scoreWeights,
        firstSeenDates,
        promptVersion: "w1",
      });
      droppedNoEvidence += scored.droppedNoEvidence;
      momentumCoerced += scored.momentumCoerced;
      topics.push(...scored.topics);
      // Doc-19 cut: score desc, richer sources, newer evidence, scorer rank.
      const newestOf = (ids: string[]): string =>
        ids.reduce((best, id) => {
          const at = itemsById.get(id)?.published_at ?? "";
          return at > best ? at : best;
        }, "");
      const byCut = (a: SortedTrendRecord, b: SortedTrendRecord): number => {
        if (a.trend_score !== b.trend_score) return b.trend_score - a.trend_score;
        if (a.source_count !== b.source_count) return b.source_count - a.source_count;
        const newerA = newestOf(a.evidence_item_ids);
        const newerB = newestOf(b.evidence_item_ids);
        if (newerA !== newerB) return newerA < newerB ? 1 : -1;
        return a.rank - b.rank;
      };
      topClusters[slug] = [...scored.topics]
        .sort(byCut)
        .slice(0, top)
        .map((topic) => bestCluster(topic.evidence_item_ids, part))
        .filter((id) => id !== "");
    }
    this.db.prepare("UPDATE runs SET topics_count = ? WHERE id = ?").run(topics.length, exec.runId);
    this.setStageDetail(exec.runId, "score", {
      topics,
      topClusters,
      topPerCategory: top,
      droppedNoEvidence,
      momentumCoerced,
    });
    emitSortEvent(this.db, this.events, exec.runId, "sort_rank", {
      ranks: topics.map((topic) => ({
        cluster_id: bestCluster(topic.evidence_item_ids, aggregated),
        rank: topic.rank,
        score: topic.trend_score,
      })),
    });
  }

  private firstSeenByItem(items: RawTrendRecord[], hashes: string[]): Map<string, string> {
    const byHash = new Map<string, string>();
    if (hashes.length > 0) {
      const placeholders = hashes.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT content_hash, first_seen_date FROM seen_items WHERE content_hash IN (${placeholders})`)
        .all(...hashes) as { content_hash: string; first_seen_date: string }[];
      for (const row of rows) byHash.set(row.content_hash, row.first_seen_date);
    }
    const out = new Map<string, string>();
    for (const item of items) {
      const date = byHash.get(item.content_hash);
      if (date) out.set(item.id, date);
    }
    return out;
  }

  private async stagePersistSorted(exec: Execution): Promise<void> {
    const scoreDetail = this.stageDetail(exec.runId, "score") as { topics?: unknown; topClusters?: unknown } | null;
    if (!scoreDetail || !Array.isArray(scoreDetail.topics)) {
      throw new RunRequestError(`score output missing for run ${exec.runId} - run score first`);
    }
    const topClusters =
      scoreDetail.topClusters !== null && typeof scoreDetail.topClusters === "object"
        ? (scoreDetail.topClusters as Record<string, string[]>)
        : {};
    const { aggregated } = this.loadClusterDetail(exec);
    const writeDetail = this.stageDetail(exec.runId, "sort_write") as { written?: unknown } | null;
    const written = (Array.isArray(writeDetail?.written) ? writeDetail.written : []) as WrittenTopic[];
    const writtenByCluster = new Map(written.map((w) => [w.text.cluster_id, w]));
    // Final sets: the score stage's top clusters per slug, rank 1..n
    // within the category, writer text patched over placeholder scores.
    const top = effectiveTopPerCategory(this.db, this.config);
    const final: SortedTrendRecord[] = [];
    for (const slug of Object.keys(topClusters).sort()) {
      const ids = topClusters[slug];
      if (!Array.isArray(ids)) continue;
      ids.slice(0, top).forEach((clusterId, i) => {
        if (typeof clusterId !== "string") return;
        const scored = (scoreDetail.topics as SortedTrendRecord[]).find(
          (t) => bestCluster(t.evidence_item_ids, aggregated) === clusterId,
        );
        if (!scored) return;
        const card = writtenByCluster.get(clusterId);
        final.push({
          ...scored,
          rank: i + 1,
          title: card?.text.title ?? scored.title,
          summary: card?.text.summary ?? scored.summary,
          tags: card?.text.tags ?? scored.tags,
          why_trending: card?.text.why_trending ?? scored.why_trending,
          content_angles: card?.text.content_angles ?? scored.content_angles,
          scope: "all",
        });
      });
    }
    const repo = this.repo();
    const labels = [...new Set(final.map((topic) => topic.category))].sort();
    if (final.length > 0) {
      const existing = await repo.readSorted({ runDate: exec.runDate, onlyLatest: false });
      const present = new Set(
        existing.rows.filter((row) => row.run_id === exec.runId).map((row) => row.topic_id),
      );
      const missing = final.filter((topic) => !present.has(topic.topic_id));
      if (missing.length > 0) await repo.appendSorted(missing);
      // One latest set per (run_date, category): a subset refresh flips
      // only its own categories, leaving the others latest.
      for (const label of labels) {
        await repo.markLatest(exec.runDate, exec.runId, { category: label });
      }
    }
    // Digest: garnish, not load-bearing — a persistent violation skips the
    // row (run goes partial) instead of failing the stage and forcing a
    // retry that would double-append the sorted rows above. Full runs (all
    // my categories, or legacy general runs) write it; a subset refresh
    // never rewrites it.
    const my = readMyCategories(this.db);
    const full =
      exec.categories.length === 0 ||
      (my.length > 0 &&
        exec.categories.length === my.length &&
        exec.categories.every((slug) => my.includes(slug)));
    let digestSkipped = false;
    const digestRow = await repo.readDigest(exec.runDate);
    if (full && final.length > 0 && !(digestRow.row && digestRow.row.run_id === exec.runId)) {
      try {
        const ranked = [...final].sort((a, b) => b.trend_score - a.trend_score);
        const digest = await generateDigest(this.sorterWriter(exec.runId), ranked.slice(0, 10));
        const counts = new Map<string, number>();
        for (const topic of final) counts.set(topic.category, (counts.get(topic.category) ?? 0) + 1);
        const topCategories = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([category, count]) => ({ category, count }));
        await repo.appendDigest(
          DigestRecord.parse({
            run_date: exec.runDate,
            run_id: exec.runId,
            digest: digest.digest,
            top_topic_id: ranked[0]?.topic_id ?? "",
            topics_count: final.length,
            items_count: this.sortItems(exec).length,
            sources_ok: exec.sourceStats.filter((s) => s.status === "ok").length,
            sources_total: exec.sourceStats.length,
            top_categories: topCategories,
            created_at: new Date().toISOString(),
            is_latest: true,
          }),
        );
        await repo.markDigestLatest(exec.runDate, exec.runId);
      } catch (error) {
        digestSkipped = true;
        const message = error instanceof Error ? error.message : String(error);
        exec.partialReasons.push(`digest skipped: ${message}`);
        this.log.warn({ runId: exec.runId, err: message }, "daily digest skipped");
      }
    }
    // Pulse index (Doc 16 G1): garnish like the digest — never fails persist.
    if (final.length > 0) {
      try {
        const { writeLatestSet } = await import("../pulse/index.js");
        const pulse = writeLatestSet(this.db, exec.runId, exec.runDate, final, this.config.pulseTopN);
        if (pulse.topChanged) {
          const top = [...final].sort((a, b) => b.trend_score - a.trend_score)[0];
          this.events.emit("pulse", "top_changed", { date: exec.runDate, topic_id: top?.topic_id ?? "" });
        }
      } catch (error) {
        this.log.warn({ runId: exec.runId, err: error instanceof Error ? error.message : String(error) }, "pulse index skipped");
      }
    }
    // Per-category outcome for the Today panels (collect wrote the rows).
    if (final.length > 0) {
      const kept = new Map<string, number>();
      for (const slug of this.assignmentsByItem(exec).values()) {
        kept.set(slug, (kept.get(slug) ?? 0) + 1);
      }
      const perCat = new Map<string, number>();
      for (const topic of final) {
        const slug = topic.category.toLowerCase();
        perCat.set(slug, (perCat.get(slug) ?? 0) + 1);
      }
      const touch = this.db.prepare(
        "UPDATE category_runs SET topics = ?, items_kept = ? WHERE run_id = ? AND category = ?",
      );
      for (const [slug, count] of perCat) {
        touch.run(count, kept.get(slug) ?? 0, exec.runId, slug);
      }
    }
    for (const slug of [...new Set(final.map((topic) => topic.category.toLowerCase()))].sort()) {
      emitSortEvent(this.db, this.events, exec.runId, "category_status", {
        category: slug,
        phase: "persist",
        status: "ok",
        topics: final.filter((topic) => topic.category.toLowerCase() === slug).length,
      });
    }
    this.db.prepare("UPDATE runs SET topics_count = ? WHERE id = ?").run(final.length, exec.runId);
    this.setStageDetail(exec.runId, "persist_sorted", {
      topicsAppended: final.length,
      digestSkipped,
      markedLatest: final.length > 0,
      categories: labels,
    });
  }

  private async stageFinalize(exec: Execution): Promise<void> {
    const repo = this.repo();
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(exec.runId) as {
      started_at: string;
      trigger: RunTrigger;
      items_collected: number;
      items_new: number;
      topics_count: number;
    };
    const stages = this.db
      .prepare("SELECT stage, status FROM run_stages WHERE run_id = ?")
      .all(exec.runId) as { stage: string; status: string }[];
    const sourceStats = this.db
      .prepare("SELECT source, status, items, duration_ms, error FROM run_source_stats WHERE run_id = ?")
      .all(exec.runId) as Record<string, unknown>[];
    const usage = this.db
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut FROM llm_calls WHERE run_id = ?",
      )
      .get(exec.runId) as { calls: number; tokensIn: number; tokensOut: number };
    const finishedAt = new Date().toISOString();
    const existingLog = await repo.readRunLog();
    const status = this.pendingStatus(exec);
    if (!existingLog.rows.some((entry) => entry.run_id === exec.runId)) {
      await repo.appendRunLog(
        RunLogRecord.parse({
          run_id: exec.runId,
          started_at: row.started_at,
          finished_at: finishedAt,
          trigger: row.trigger,
          status,
          stages,
          source_stats: sourceStats,
          items_collected: row.items_collected,
          items_new: row.items_new,
          topics_count: row.topics_count,
          llm_calls: usage.calls,
          tokens_in: usage.tokensIn,
          tokens_out: usage.tokensOut,
          errors: exec.partialReasons,
          app_version: APP_VERSION,
          categories: exec.categories,
        }),
      );
    }
    // Retention is janitorial: failures are recorded, never fatal.
    let retention: unknown = { skipped: true };
    try {
      const { retentionDays, retentionMode } = exec.settings;
      retention = await repo.retainRaw({
        runDate: exec.runDate,
        retentionDays,
        retentionMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      retention = { error: message };
      this.log.warn({ runId: exec.runId, err: message }, "retention job failed (non-fatal)");
    }
    this.setStageDetail(exec.runId, "finalize", { retention });
    this.events.emit(exec.runId, "done", { status });
  }

  // ── finishing ──────────────────────────────────────────────────────────

  /** Status if the run completed without stage failure. */
  private pendingStatus(exec: Execution): "success" | "partial" {
    return exec.partialReasons.length > 0 ? "partial" : "success";
  }

  private finishRun(exec: Execution): RunSummary {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(exec.runId) as
      | { status: string }
      | undefined;
    if (row?.status !== "failed") {
      const status = this.pendingStatus(exec);
      this.db
        .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
        .run(status, new Date().toISOString(), exec.runId);
    }
    return this.summary(exec);
  }

  /** Checkpoint a stage/run failure, then rethrow (never returns). */
  private finishFailed(runId: string, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
      .run(new Date().toISOString(), message, runId);
    if (error instanceof Error) throw error;
    throw new Error(message);
  }

  private summary(exec: Execution): RunSummary {
    const row = this.db.prepare(
      "SELECT status, items_collected, items_new, topics_count FROM runs WHERE id = ?",
    ).get(exec.runId) as {
      status: string;
      items_collected: number;
      items_new: number;
      topics_count: number;
    };
    return {
      runId: exec.runId,
      runDate: exec.runDate,
      status: row.status,
      itemsCollected: row.items_collected,
      itemsNew: row.items_new,
      topicsCount: row.topics_count,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private ensureSources(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO sources (key, enabled, item_limit, config_json) VALUES (?, 1, 50, '{}')",
    );
    const write = this.db.transaction(() => {
      for (const key of SourceKey.options) insert.run(key);
    });
    write();
  }

  private enabledSources(): SourceKey[] {
    const rows = this.db.prepare("SELECT key, enabled FROM sources").all() as {
      key: string;
      enabled: number;
    }[];
    const map = new Map(rows.map((row) => [row.key, row.enabled]));
    return [...SourceKey.options].filter((key) => map.get(key) ?? true);
  }

  private sourceLimitsConfigs(
    keys: SourceKey[],
    limitOverride?: number,
  ): {
    limits: Partial<Record<SourceKey, number>>;
    configs: Partial<Record<SourceKey, Record<string, unknown>>>;
  } {
    const limits: Partial<Record<SourceKey, number>> = {};
    const configs: Partial<Record<SourceKey, Record<string, unknown>>> = {};
    const rows = this.db
      .prepare(`SELECT key, item_limit, config_json FROM sources WHERE key IN (${keys.map(() => "?").join(", ")})`)
      .all(...keys) as {
      key: string;
      item_limit: number;
      config_json: string;
    }[];
    const map = new Map(rows.map((row) => [row.key, row]));
    for (const key of keys) {
      const found = map.get(key);
      limits[key] = limitOverride ?? found?.item_limit ?? this.config.maxItemsPerSource;
      configs[key] = found ? parseConfigJson(found.config_json) : {};
    }
    return { limits, configs };
  }

  private collectContext(runId: string, limitOverride?: number): Omit<CollectContext, "config"> {
    const http = new HttpClient({
      userAgent: this.config.userAgent,
      limiter: new DomainRateLimiter({}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    const llm: LlmExtractor =
      this.deps.extractor ??
      (this.config.omnirouteApiKey && this.config.omnirouteExtractModel
        ? createExtractor(
            createExtractorClient(this.config, {
              onCall: (record) => {
                recordLlmCall(this.db, runId, record);
              },
            }),
          )
        : {
            model: "(unset)",
            extract: () =>
              Promise.reject(new Error("OMNIROUTE_API_KEY not set — webpage extraction skipped")),
          });
    // runCollectors injects the per-source config on each call.
    return {
      runId,
      limit: limitOverride ?? this.config.maxItemsPerSource,
      niches: this.config.niches,
      geo: this.config.trendsGeo,
      enablePlaywright: this.config.enablePlaywright,
      http,
      llm,
      scraping: scrapingClient(),
      signal: new AbortController().signal,
      log: this.log,
    };
  }

  private sorterClassifier(runId: string): Classifier {
    if (this.deps.classifier) return this.deps.classifier;
    return new JevClassifier(this.sorterJev(runId));
  }

  private sorterJev(runId: string): JevClient {
    if (this.deps.pairJevClient) return this.deps.pairJevClient;
    return new JevClient({
      baseUrl: this.config.jevBaseUrl,
      path: this.config.jevPath,
      apiKey: this.config.jevApiKey,
      model: this.config.jevModel,
      concurrency: this.config.jevConcurrency,
      pricePerMInput: this.config.jevPricePerMInput,
      budgetUsd: this.config.jevRunBudgetUsd,
      timeoutMs: this.config.llmTimeoutMs,
      onCall: (record) => {
        recordLlmCall(this.db, runId, record);
      },
    });
  }

  private sorterFallback(runId: string): Classifier | undefined {
    if (this.deps.fallbackClassifier) return this.deps.fallbackClassifier;
    if (this.config.omnirouteFallbackModel.trim() === "") return undefined;
    return new FallbackClassifier(
      new LlmClient({
        baseUrl: this.config.omnirouteBaseUrl,
        apiKey: this.config.omnirouteApiKey,
        model: this.config.omnirouteFallbackModel,
        clientName: "extractor",
        timeoutMs: this.config.llmTimeoutMs,
        onCall: (record) => {
          recordLlmCall(this.db, runId, record);
        },
      }),
    );
  }

  /** pairJevClient doubles as the same_story client; fresh instance otherwise. */
  private sorterPairClient(runId: string): JevClient | undefined {
    if (this.deps.pairJevClient) return this.deps.pairJevClient;
    if (this.config.jevApiKey.trim() === "" && this.config.jevBaseUrl.trim() === "") return undefined;
    return this.sorterJev(runId);
  }

  private sorterWriter(runId: string): LlmClient {
    if (this.deps.writerClient) return this.deps.writerClient;
    return new LlmClient({
      baseUrl: this.config.omnirouteBaseUrl,
      apiKey: this.config.omnirouteApiKey,
      model: this.config.omnirouteWriterModel,
      clientName: "extractor",
      timeoutMs: this.config.llmTimeoutMs,
      onCall: (record) => {
        recordLlmCall(this.db, runId, record);
      },
    });
  }

  private setStage(runId: string, stage: StageName, status: string, detail?: Record<string, unknown>): void {
    const existing = this.db
      .prepare("SELECT status FROM run_stages WHERE run_id = ? AND stage = ?")
      .get(runId, stage) as { status: string } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO run_stages (run_id, stage, status, started_at) VALUES (?, ?, ?, ?)")
        .run(runId, stage, status, new Date().toISOString());
    } else {
      this.db
        .prepare("UPDATE run_stages SET status = ?, finished_at = ? WHERE run_id = ? AND stage = ?")
        .run(status, new Date().toISOString(), runId, stage);
    }
    if (detail !== undefined) this.setStageDetail(runId, stage, detail);
  }

  private setStageDetail(runId: string, stage: StageName, detail: unknown): void {
    this.db
      .prepare("UPDATE run_stages SET detail_json = ? WHERE run_id = ? AND stage = ?")
      .run(JSON.stringify(detail), runId, stage);
  }

  private stageDetail(runId: string, stage: StageName): unknown {
    const row = this.db.prepare("SELECT detail_json FROM run_stages WHERE run_id = ? AND stage = ?").get(runId, stage) as
      | { detail_json: string | null }
      | undefined;
    if (!row?.detail_json) return null;
    return JSON.parse(row.detail_json) as unknown;
  }

  private stageStatuses(runId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT stage, status FROM run_stages WHERE run_id = ?").all(runId) as {
      stage: string;
      status: string;
    }[];
    return new Map(rows.map((row) => [row.stage, row.status]));
  }

  private loadSourceStats(runId: string): SourceStats[] {
    const rows = this.db
      .prepare("SELECT source, status, items, duration_ms, error FROM run_source_stats WHERE run_id = ?")
      .all(runId) as { source: SourceKey; status: "ok" | "error" | "blocked" | "skipped"; items: number; duration_ms: number; error: string | null }[];
    return rows.map((row) => ({
      source: row.source,
      status: row.status,
      items: row.items,
      duration_ms: row.duration_ms,
      error: row.error,
    }));
  }

  private hasPersistedRows(runId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_id = ? AND persisted = 1").get(runId) as {
      n: number;
    };
    return row.n > 0;
  }
}

function parseConfigJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
