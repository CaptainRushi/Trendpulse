import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { EventBus } from "../../src/pipeline/events.js";
import { formatSseEvent, runHistory, streamRunEvents, SSE_HISTORY_LIMIT } from "../../src/api/sse.js";

describe("sse helpers", () => {
  it("formats wire events per the schema §4 example", () => {
    const line = formatSseEvent({
      seq: 3,
      runId: "run-1",
      type: "source",
      at: "2026-09-30T06:00:00.000Z",
      data: { source: "reddit", status: "ok", items: 50, duration_ms: 1840 },
    });
    expect(line).toBe(
      'event: source\ndata: {"run_id":"run-1","source":"reddit","status":"ok","items":50,"duration_ms":1840}\n\n',
    );
  });

  it("replays the run's last 50 events only", () => {
    const bus = new EventBus();
    for (let i = 0; i < SSE_HISTORY_LIMIT + 10; i++) bus.emit("run-a", "log", { i });
    bus.emit("run-b", "log", { other: true });
    const replayed = runHistory(bus, "run-a");
    expect(replayed).toHaveLength(SSE_HISTORY_LIMIT);
    expect(replayed[0]?.data["i"]).toBe(10);
    expect(replayed.every((e) => e.runId === "run-a")).toBe(true);
  });

  it("late emits and heartbeats after disconnect never throw", () => {
    const bus = new EventBus();
    const writes: string[] = [];
    let ended = false;
    const raw = {
      writeHead: (): void => undefined,
      // Mimics ServerResponse: throws ERR_STREAM_WRITE_AFTER_END once ended.
      write: (chunk: string): boolean => {
        if (ended) {
          throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
        }
        writes.push(chunk);
        return true;
      },
      end: (): void => {
        ended = true;
      },
      get writableEnded(): boolean {
        return ended;
      },
      destroyed: false,
    };
    const requestRaw = new EventEmitter();
    vi.useFakeTimers();
    try {
      streamRunEvents(
        { raw: requestRaw } as unknown as FastifyRequest,
        { raw } as unknown as FastifyReply,
        bus,
        "run-1",
      );
      bus.emit("run-1", "log", { i: 1 });
      expect(writes).toHaveLength(1);
      // Run finishes: stream ends. Straggler emits and the heartbeat must
      // stay silent instead of throwing ERR_STREAM_WRITE_AFTER_END.
      bus.emit("run-1", "done", {});
      expect(writes).toHaveLength(2);
      expect(() => {
        bus.emit("run-1", "log", { i: 2 });
        vi.advanceTimersByTime(60_000);
      }).not.toThrow();
      expect(writes).toHaveLength(2);
      // Same guarantee after a client disconnect.
      requestRaw.emit("close");
      expect(() => {
        bus.emit("run-1", "log", { i: 3 });
        vi.advanceTimersByTime(60_000);
      }).not.toThrow();
      expect(writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
