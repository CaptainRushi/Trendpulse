import { describe, expect, it } from "vitest";
import { EventBus, EVENT_HISTORY_LIMIT } from "../../src/pipeline/events.js";

describe("EventBus", () => {
  it("delivers to subscribers and unsubscribes cleanly", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe((event) => {
      const stage = event.data["stage"];
      seen.push(typeof stage === "string" ? `${event.type}:${stage}` : event.type);
    });
    bus.emit("run-1", "stage", { stage: "collect" });
    off();
    bus.emit("run-1", "stage", { stage: "score" });
    expect(seen).toEqual(["stage:collect"]);
  });

  it("numbers events sequentially and keeps bounded history", () => {
    const bus = new EventBus();
    for (let i = 0; i < EVENT_HISTORY_LIMIT + 10; i++) bus.emit("r", "log", { i });
    expect(bus.history(EVENT_HISTORY_LIMIT + 100)).toHaveLength(EVENT_HISTORY_LIMIT);
    const tail = bus.history(3);
    expect(tail.map((e) => e.seq)).toEqual([
      EVENT_HISTORY_LIMIT + 8,
      EVENT_HISTORY_LIMIT + 9,
      EVENT_HISTORY_LIMIT + 10,
    ]);
  });
});
