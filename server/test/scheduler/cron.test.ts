import { describe, expect, it, vi } from "vitest";
import { PipelineScheduler } from "../../src/scheduler/cron.js";
import { LockBusyError } from "../../src/scheduler/lock.js";
import { openTestDb } from "../pipeline/helpers.js";
import { insertRun } from "../pipeline/helpers.js";

const DAY = "2026-09-30";

describe("PipelineScheduler", () => {
  it("rejects invalid cron expressions at construction", () => {
    expect(
      () =>
        new PipelineScheduler({
          cronExpression: "not a cron",
          timezone: "UTC",
          onTrigger: () => Promise.resolve(),
        }),
    ).toThrow(/Invalid SCHEDULE_CRON/);
  });

  it("starts and stops without firing synchronously", () => {
    const onTrigger = vi.fn(() => Promise.resolve());
    const scheduler = new PipelineScheduler({
      cronExpression: "0 6 * * *",
      timezone: "UTC",
      onTrigger,
    });
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.start(); // idempotent
    scheduler.stop();
    expect(scheduler.running).toBe(false);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("needsCatchup fires only without a successful run that date", () => {
    const db = openTestDb();
    try {
      const scheduler = new PipelineScheduler({
        cronExpression: "0 6 * * *",
        timezone: "UTC",
        onTrigger: () => Promise.resolve(),
      });
      expect(scheduler.needsCatchup(db, DAY)).toBe(true);
      insertRun(db, "run-partial", DAY);
      db.prepare("UPDATE runs SET status = 'partial' WHERE id = 'run-partial'").run();
      expect(scheduler.needsCatchup(db, DAY)).toBe(true); // partial still catches up
      insertRun(db, "run-ok", DAY);
      db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-ok'").run();
      expect(scheduler.needsCatchup(db, DAY)).toBe(false);
      expect(scheduler.needsCatchup(db, "2026-09-29")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("exposes LockBusyError for the 409 mapping (documented contract)", () => {
    const error = new LockBusyError("run-holder");
    expect(error.holderRunId).toBe("run-holder");
    expect(error.message).toContain("run-holder");
  });
});
