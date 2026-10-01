import { describe, expect, it } from "vitest";
import {
  acquirePipelineLock,
  heartbeatPipelineLock,
  LockBusyError,
  recoverOnBoot,
  releasePipelineLock,
} from "../../src/scheduler/lock.js";
import { openTestDb } from "../pipeline/helpers.js";
import { insertRun } from "../pipeline/helpers.js";

const DAY = "2026-09-30";
const T0 = Date.parse("2026-09-30T06:00:00.000Z");

function lockRow(db: ReturnType<typeof openTestDb>): { run_id: string | null } | undefined {
  return db.prepare("SELECT run_id FROM locks WHERE name = 'pipeline'").get() as
    | { run_id: string | null }
    | undefined;
}

describe("pipeline lock", () => {
  it("second acquire throws LockBusyError naming the holder", () => {
    const db = openTestDb();
    try {
      acquirePipelineLock(db, "run-a", T0);
      expect(() => {
        acquirePipelineLock(db, "run-b", T0 + 1000);
      }).toThrowError(LockBusyError);
      try {
        acquirePipelineLock(db, "run-b", T0 + 1000);
      } catch (error) {
        expect((error as LockBusyError).holderRunId).toBe("run-a");
      }
      expect(lockRow(db)?.run_id).toBe("run-a"); // failed steal changed nothing
    } finally {
      db.close();
    }
  });

  it("steals stale locks and refreshes heartbeats", () => {
    const db = openTestDb();
    try {
      acquirePipelineLock(db, "run-a", T0);
      acquirePipelineLock(db, "run-b", T0 + 6 * 60 * 1000); // 6 min later: stale
      expect(lockRow(db)?.run_id).toBe("run-b");
      expect(heartbeatPipelineLock(db, "run-b", T0 + 7 * 60 * 1000)).toBe(true);
      expect(heartbeatPipelineLock(db, "run-a", T0 + 7 * 60 * 1000)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("releases only its own lock", () => {
    const db = openTestDb();
    try {
      acquirePipelineLock(db, "run-a", T0);
      expect(releasePipelineLock(db, "run-b")).toBe(false);
      expect(lockRow(db)?.run_id).toBe("run-a");
      expect(releasePipelineLock(db, "run-a")).toBe(true);
      expect(lockRow(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("recoverOnBoot", () => {
  it("interrupts running runs and frees their locks immediately", () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-dead", DAY);
      acquirePipelineLock(db, "run-dead", T0);
      const result = recoverOnBoot(db, T0 + 30 * 1000); // 30s later: heartbeat still fresh
      expect(result.interruptedRuns).toEqual(["run-dead"]);
      expect(result.releasedStaleLocks).toBe(1);
      // A retry right away must not meet a bogus 409.
      acquirePipelineLock(db, "run-retry", T0 + 30 * 1000);
      expect(lockRow(db)?.run_id).toBe("run-retry");
    } finally {
      db.close();
    }
  });

  it("marks running runs interrupted even with fresh heartbeats", () => {
    const db = openTestDb();
    try {
      insertRun(db, "run-live", DAY);
      acquirePipelineLock(db, "run-live", T0);
      const result = recoverOnBoot(db, T0 + 30 * 1000);
      expect(result.interruptedRuns).toEqual(["run-live"]);
      // Boot owns this decision: a lock held across a boot belongs to a dead
      // process. Two live servers at once is operator error (the second boot
      // would interrupt the first) — localhost runs one.
      expect(result.releasedStaleLocks).toBe(1);
    } finally {
      db.close();
    }
  });

  it("releases locks with no runs row and stale heartbeats", () => {
    const db = openTestDb();
    try {
      acquirePipelineLock(db, "run-ghost", T0 - 10 * 60 * 1000);
      const result = recoverOnBoot(db, T0);
      expect(result.releasedStaleLocks).toBe(1);
      expect(result.interruptedRuns).toEqual([]);
    } finally {
      db.close();
    }
  });
});
