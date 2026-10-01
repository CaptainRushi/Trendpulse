/**
 * Daily scheduler (TRD §10): node-cron with SCHEDULE_CRON + TZ fires
 * orchestrator runs; boot checks for a missed run. A busy pipeline is
 * normal (a run is already going) — logged, never thrown out of the tick.
 */
import cron from "node-cron";
import type { Logger } from "pino";
import { createLogger } from "../utils/logger.js";
import type { StateDb } from "../db/sqlite.js";
import type { RunTrigger } from "../pipeline/orchestrator.js";
import { LockBusyError } from "./lock.js";

export interface SchedulerOptions {
  cronExpression: string;
  timezone: string;
  onTrigger: (trigger: RunTrigger) => Promise<unknown>;
  log?: Logger;
}

export class PipelineScheduler {
  private expression: string;
  private timezone: string;
  private readonly onTrigger: (trigger: RunTrigger) => Promise<unknown>;
  private readonly log: Logger;
  private task: cron.ScheduledTask | null = null;

  constructor(options: SchedulerOptions) {
    if (!cron.validate(options.cronExpression)) {
      throw new Error(
        `Invalid SCHEDULE_CRON: ${JSON.stringify(options.cronExpression)} (expected 5-field cron, e.g. "0 6 * * *")`,
      );
    }
    this.expression = options.cronExpression;
    this.timezone = options.timezone;
    this.onTrigger = options.onTrigger;
    this.log = options.log ?? createLogger("info");
  }

  /** Begin firing on the cron schedule (idempotent). */
  start(): void {
    if (this.task) return;
    this.task = cron.schedule(
      this.expression,
      () => {
        this.fire("cron").catch((error: unknown) => {
          this.log.error(
            { err: error instanceof Error ? error.message : String(error) },
            "scheduled run failed",
          );
        });
      },
      { timezone: this.timezone },
    );
    this.log.info(
      { cron: this.expression, timezone: this.timezone },
      "scheduler started",
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * Hot-restart with a new expression/timezone (settings PUT). Keeps the
   * running state: a live scheduler stays live on the new schedule.
   */
  reschedule(cronExpression: string, timezone: string): void {
    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid SCHEDULE_CRON: ${JSON.stringify(cronExpression)} (expected 5-field cron, e.g. "0 6 * * *")`,
      );
    }
    const wasRunning = this.task !== null;
    this.task?.stop();
    this.task = null;
    this.expression = cronExpression;
    this.timezone = timezone;
    if (wasRunning) this.start();
  }

  get running(): boolean {
    return this.task !== null;
  }

  private async fire(trigger: RunTrigger): Promise<void> {
    try {
      await this.onTrigger(trigger);
    } catch (error) {
      if (error instanceof LockBusyError) {
        this.log.warn(
          { holder: error.holderRunId },
          "scheduled run skipped — pipeline is already running",
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Missed-run check for boot: true when no successful run exists for the
   * given app-tz date (TRD §10, literal). A partial day gets a fresh full
   * run — safe by construction: the seen filter makes same-day re-runs add
   * 0 raw rows, and persist_sorted skips markLatest when there is nothing
   * new to crown.
   */
  needsCatchup(db: StateDb, runDate: string): boolean {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE run_date = ? AND status = 'success'")
      .get(runDate) as { n: number };
    return row.n === 0;
  }
}
