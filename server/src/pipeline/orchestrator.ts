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
import type { CollectContext, RawItemDraft, SourceStats } from "../collectors/types.js";
import { createLogger } from "../utils/logger.js";
import { DomainRateLimiter } from "../utils/rate-limit.js";
import { ulid } from "../utils/ulid.js";
import type { TrendPulseConfig } from "../config/env.js";
import { resolveEffectiveSettings } from "../config/settings.js";
import type { EffectiveSettings } from "../config/settings.js";
import { pipelineBus } from "./events.js";
import type { EventBus } from "./events.js";
import type { StateDb } from "../db/sqlite.js";
import { createExtractor, type LlmExtractor } from "../llm/extract.js";
import { createExtractorClient, createJevClient } from "../llm/factory.js";
import { recordLlmCall } from "../llm/log.js";
import { LlmHttpError, LlmTimeoutError, LlmValidationError } from "../llm/client.js";
import { SheetsApiError } from "../sheets/client.js";
import { createRealSheetsClient } from "../sheets/realClient.js";
import type { SheetsClient } from "../sheets/client.js";
import { SheetsRepo } from "../sheets/repo.js";
import type { SheetsWriteQueue } from "../sheets/queue.js";
import { DigestRecord, RunLogRecord, SourceKey } from "../sheets/schema.js";
import type { RawTrendRecord, SortedTrendRecord } from "../sheets/schema.js";
import { generateDigest } from "../sorting/digest.js";
import { mapAllBatches } from "../sorting/map.js";
import type { JevJsonClient, JevTopic } from "../sorting/map.js";
import { reduceTopics } from "../sorting/reduce.js";
import { scoreTopics } from "../sorting/score.js";
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
  "engagement_norm",
  "persist_raw",
  "sort_map",
  "sort_reduce",
  "score",
  "persist_sorted",
  "finalize",
] as const;
export type StageName = (typeof STAGES)[number];

const SORT_STAGES: StageName[] = ["sort_map", "sort_reduce", "score", "persist_sorted", "finalize"];
const PRE_PERSIST: StageName[] = ["collect", "normalize", "dedupe", "engagement_norm", "persist_raw"];

export type RunTrigger = "cron" | "manual" | "catchup";

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
  /** Sort client. Default: real Jev client with llm_calls logging. */
  jevClient?: JevJsonClient;
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
}

export interface RunSummary {
  runId: string;
  runDate: string;
  status: string;
  itemsCollected: number;
  itemsNew: number;
  topicsCount: number;
}

interface Execution {
  runId: string;
  runDate: string;
  trigger: RunTrigger;
  requested: StageName[];
  sources: SourceKey[];
  limitOverride?: number;
  settings: EffectiveSettings;
  drafts: RawItemDraft[];
  sourceStats: SourceStats[];
  partialReasons: string[];
}

function isOperationalError(error: unknown): boolean {
  return (
    error instanceof SheetsApiError ||
    error instanceof LlmValidationError ||
    error instanceof LlmHttpError ||
    error instanceof LlmTimeoutError
  );
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
    const requested = options.stages ?? [...STAGES];
    if (requested.length === 0) throw new Error("at least one stage must be requested");
    for (const stage of requested) {
      if (!(STAGES as readonly string[]).includes(stage)) {
        throw new Error(`unknown stage '${stage}' (stages: ${STAGES.join(", ")})`);
      }
    }
    const runId = ulid();
    const runDate = options.runDate ?? new Date().toLocaleDateString("en-CA", { timeZone: this.config.tz });
    acquirePipelineLock(this.db, runId);
    const heartbeat = setInterval(() => {
      heartbeatPipelineLock(this.db, runId);
    }, LOCK_HEARTBEAT_MS);
    try {
      const startedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(runId, runDate, options.trigger, JSON.stringify(requested), startedAt);
      for (const stage of requested) {
        this.setStage(runId, stage, "pending");
      }
      const { settings, warnings } = resolveEffectiveSettings(this.db, this.config);
      for (const warning of warnings) this.log.warn({ runId }, warning);
      this.ensureSources();
      const sources = options.sources ?? this.enabledSources();
      if (sources.length === 0) throw new Error("no enabled sources (see sources table)");
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
      };
      if (options.limit !== undefined) exec.limitOverride = options.limit;
      const first = requested[0];
      if (!first) throw new Error("at least one stage must be requested");
      await this.executeFrom(exec, first);
      return this.finishRun(exec);
    } catch (error) {
      // finishRun checkpoints the failure for operational errors; unexpected
      // errors propagate with stage/run left running (kill semantics).
      if (isOperationalError(error)) return this.finishFailed(runId, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      releasePipelineLock(this.db, runId);
    }
  }

  /**
   * Resume an interrupted/failed run from its first non-done requested
   * stage (or an explicit earlier stage). Refuses to rewind at or before
   * persist_raw once rows are persisted — those already map to sheet
   * content and re-preparing would mint new ULIDs for the same stories.
   */
  async retryRun(runId: string, fromStage?: StageName): Promise<RunSummary> {
    const row = this.db.prepare("SELECT id, run_date, trigger, status, stages_requested FROM runs WHERE id = ?").get(runId) as
      | { id: string; run_date: string; trigger: RunTrigger; status: string; stages_requested: string }
      | undefined;
    if (!row) throw new Error(`run ${runId} not found`);
    const requested = JSON.parse(row.stages_requested) as StageName[];
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new Error(`run ${runId} has no pipeline stages (not an orchestrator run?)`);
    }
    if (row.status !== "failed" && row.status !== "interrupted") {
      throw new Error(`run ${runId} is ${row.status} — only failed/interrupted runs resume`);
    }
    acquirePipelineLock(this.db, runId);
    const heartbeat = setInterval(() => {
      heartbeatPipelineLock(this.db, runId);
    }, LOCK_HEARTBEAT_MS);
    try {
      const statuses = this.stageStatuses(runId);
      const firstOpen = requested.find((stage) => statuses.get(stage) !== "done");
      const from = fromStage ?? firstOpen;
      if (!from) throw new Error(`run ${runId} has nothing to resume (all stages done)`);
      if (!requested.includes(from)) throw new Error(`stage '${from}' was not requested by run ${runId}`);
      if (PRE_PERSIST.includes(from) && this.hasPersistedRows(runId)) {
        throw new Error(
          `run ${runId} already persisted rows — resume from sort_map or later, or start a new run`,
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
      };
      await this.executeFrom(exec, from);
      return this.finishRun(exec);
    } catch (error) {
      if (isOperationalError(error)) return this.finishFailed(runId, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      releasePipelineLock(this.db, runId);
    }
  }

  /**
   * Re-sort-only: a fresh run over a date's persisted items (no collect,
   * no prepare — the working set already exists). Appends a new latest set
   * and flips the old one via markLatest.
   */
  async resortRun(runDate: string, options: { sources?: SourceKey[] } = {}): Promise<RunSummary> {
    const items = readRunItemsByDate(this.db, runDate);
    if (items.length === 0) throw new Error(`no persisted items for date ${runDate} — nothing to re-sort`);
    const summary = await this.startRun({
      trigger: "manual",
      runDate,
      stages: [...SORT_STAGES],
      ...(options.sources ? { sources: options.sources } : {}),
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
      engagement_norm: () => {
        this.stageNoop(exec, "engagement_norm");
      },
      persist_raw: () => this.stagePersistRaw(exec),
      sort_map: () => this.stageSortMap(exec),
      sort_reduce: () => this.stageSortReduce(exec),
      score: () => {
        this.stageScore(exec);
      },
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

  private async runStage(exec: Execution, stage: StageName, handler: () => Promise<void> | void): Promise<void> {
    this.setStage(exec.runId, stage, "running");
    this.events.emit(exec.runId, "stage", { stage, status: "running" });
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
  }

  /** normalize/dedupe/engagement_norm share prepareRunItems' atomic unit. */
  private stageNoop(exec: Execution, stage: StageName): void {
    this.setStageDetail(exec.runId, stage, { via: "prepareRunItems" });
  }

  // ── stages ─────────────────────────────────────────────────────────────

  private async stageCollect(exec: Execution): Promise<void> {
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
      if (stat.status === "error") {
        exec.partialReasons.push(`source ${stat.source}: ${stat.error ?? "unknown error"}`);
      }
    }
    this.db.prepare("UPDATE runs SET items_collected = ? WHERE id = ?").run(out.items.length, exec.runId);
    exec.drafts = out.items;
    exec.sourceStats = out.stats;
    this.setStageDetail(exec.runId, "collect", { keys: exec.sources });
  }

  private async stagePrepare(exec: Execution): Promise<void> {
    if (exec.drafts.length === 0) {
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

  private async stagePersistRaw(exec: Execution): Promise<void> {
    const result = await persistRawItems(this.db, this.repo(), exec.runId, exec.runDate);
    this.setStageDetail(exec.runId, "persist_raw", result);
  }

  private sortItems(exec: Execution): RawTrendRecord[] {
    // Re-sort runs own no rows under their own id — read the date's set.
    const resort = !exec.requested.includes("collect");
    return resort ? readRunItemsByDate(this.db, exec.runDate) : readRunItems(this.db, exec.runId);
  }

  private async stageSortMap(exec: Execution): Promise<void> {
    const items = this.sortItems(exec);
    const mapped = await mapAllBatches({
      client: this.jevClient(exec.runId),
      items,
      niches: this.config.niches,
      runDate: exec.runDate,
      batchSize: exec.settings.sortBatchSize,
      concurrency: this.config.llmConcurrency,
      log: this.log,
    });
    const statusOf = new Map<string, "sorted" | "discarded" | "sort_failed">();
    for (const topic of mapped.topics) {
      for (const id of topic.item_ids) statusOf.set(id, "sorted");
    }
    for (const entry of mapped.discarded) statusOf.set(entry.item_id, "discarded");
    for (const id of mapped.failedItemIds) statusOf.set(id, "sort_failed");
    if (mapped.failedItemIds.length > 0) {
      exec.partialReasons.push(`${String(mapped.failedItemIds.length)} items sort_failed`);
    }
    const update = this.db.prepare("UPDATE items_run SET sort_status = ? WHERE id = ?");
    const write = this.db.transaction(() => {
      for (const [id, status] of statusOf) update.run(status, id);
    });
    write();
    this.setStageDetail(exec.runId, "sort_map", {
      topics: mapped.topics,
      discarded: mapped.discarded,
      failedItemIds: mapped.failedItemIds,
      batchCount: mapped.batchCount,
      droppedUnknownIds: mapped.droppedUnknownIds,
      duplicateClaims: mapped.duplicateClaims,
    });
  }

  private loadMapDetail(exec: Execution): { topics: JevTopic[]; batchCount: number } {
    const detail = this.stageDetail(exec.runId, "sort_map") as {
      topics?: unknown;
      batchCount?: unknown;
    } | null;
    if (!detail || !Array.isArray(detail.topics)) {
      throw new Error(`sort_map output missing for run ${exec.runId} — run sort_map first`);
    }
    return {
      topics: detail.topics as JevTopic[],
      batchCount: typeof detail.batchCount === "number" ? detail.batchCount : 1,
    };
  }

  private async stageSortReduce(exec: Execution): Promise<void> {
    const map = this.loadMapDetail(exec);
    const items = this.sortItems(exec);
    const reduced = await reduceTopics({
      client: this.jevClient(exec.runId),
      topics: map.topics,
      knownItemIds: new Set(items.map((item) => item.id)),
      batchCount: map.batchCount,
      log: this.log,
    });
    this.setStageDetail(exec.runId, "sort_reduce", {
      topics: reduced.topics,
      reduced: reduced.reduced,
      droppedUnknownIds: reduced.droppedUnknownIds,
      duplicateClaims: reduced.duplicateClaims,
    });
  }

  private stageScore(exec: Execution): void {
    const detail = this.stageDetail(exec.runId, "sort_reduce") as { topics?: unknown } | null;
    if (!detail || !Array.isArray(detail.topics)) {
      throw new Error(`sort_reduce output missing for run ${exec.runId} — run sort_reduce first`);
    }
    const items = this.sortItems(exec);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const hashes = [...new Set(items.map((item) => item.content_hash))];
    const firstSeenDates = this.firstSeenByItem(items, hashes);
    const scored = scoreTopics({
      topics: detail.topics as JevTopic[],
      itemsById,
      runId: exec.runId,
      runDate: exec.runDate,
      jevModel: this.jevClient(exec.runId).modelId,
      weights: exec.settings.scoreWeights,
      topN: exec.settings.topN,
      firstSeenDates,
    });
    this.db.prepare("UPDATE runs SET topics_count = ? WHERE id = ?").run(scored.topics.length, exec.runId);
    this.setStageDetail(exec.runId, "score", {
      topics: scored.topics,
      droppedNoEvidence: scored.droppedNoEvidence,
      momentumCoerced: scored.momentumCoerced,
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
    const detail = this.stageDetail(exec.runId, "score") as { topics?: unknown } | null;
    if (!detail || !Array.isArray(detail.topics)) {
      throw new Error(`score output missing for run ${exec.runId} — run score first`);
    }
    const topics = detail.topics as SortedTrendRecord[];
    const repo = this.repo();
    if (topics.length > 0) {
      const existing = await repo.readSorted({ runDate: exec.runDate, onlyLatest: false });
      const present = new Set(
        existing.rows.filter((row) => row.run_id === exec.runId).map((row) => row.topic_id),
      );
      const missing = topics.filter((topic) => !present.has(topic.topic_id));
      if (missing.length > 0) await repo.appendSorted(missing);
      await repo.markLatest(exec.runDate, exec.runId);
    }
    // Digest: garnish, not load-bearing — a persistent violation skips the
    // row (run goes partial) instead of failing the stage and forcing a
    // retry that would double-append the sorted rows above.
    let digestSkipped = false;
    const digestRow = await repo.readDigest(exec.runDate);
    if (topics.length > 0 && !(digestRow.row && digestRow.row.run_id === exec.runId)) {
      try {
        const top = [...topics].sort((a, b) => a.rank - b.rank).slice(0, 5);
        const digest = await generateDigest(this.jevClient(exec.runId), top);
        const categories = new Map<string, number>();
        for (const topic of topics) categories.set(topic.category, (categories.get(topic.category) ?? 0) + 1);
        const topCategories = [...categories.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([category, count]) => ({ category, count }));
        await repo.appendDigest(
          DigestRecord.parse({
            run_date: exec.runDate,
            run_id: exec.runId,
            digest: digest.digest,
            top_topic_id: topics[0]?.topic_id ?? "",
            topics_count: topics.length,
            items_count: this.sortItems(exec).length,
            sources_ok: exec.sourceStats.filter((s) => s.status === "ok").length,
            sources_total: exec.sourceStats.length,
            top_categories: topCategories,
            created_at: new Date().toISOString(),
            is_latest: true,
          }),
        );
      } catch (error) {
        digestSkipped = true;
        const message = error instanceof Error ? error.message : String(error);
        exec.partialReasons.push(`digest skipped: ${message}`);
        this.log.warn({ runId: exec.runId, err: message }, "daily digest skipped");
      }
    }
    this.setStageDetail(exec.runId, "persist_sorted", {
      topicsAppended: topics.length,
      digestSkipped,
      markedLatest: topics.length > 0,
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
      (this.config.omnirouteApiKey
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
      signal: new AbortController().signal,
      log: this.log,
    };
  }

  private jevClient(runId: string): JevJsonClient {
    if (this.deps.jevClient) return this.deps.jevClient;
    return createJevClient(this.config, {
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
      .all(runId) as { source: SourceKey; status: "ok" | "error" | "skipped"; items: number; duration_ms: number; error: string | null }[];
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
