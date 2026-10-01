import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/pipeline/events.js";
import { formatSseEvent, runHistory, SSE_HISTORY_LIMIT } from "../../src/api/sse.js";

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
});
