/**
 * UI-04: run progress arrives over mocked SSE (stage/source/progress/done).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRunEvents } from "./useEventSource.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Listener = (event: { data: string }) => void;

class FakeSource {
  static instances: FakeSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }

  close(): void {
    this.closed = true;
  }
}

describe("useRunEvents", () => {
  it("UI-04 collects stage/source/progress events and closes on done", async () => {
    FakeSource.instances = [];
    vi.stubGlobal("EventSource", FakeSource);
    const { result } = renderHook(() => useRunEvents("run-1"));

    expect(FakeSource.instances).toHaveLength(1);
    expect(FakeSource.instances[0]?.url).toBe("/api/runs/run-1/stream");

    act(() => {
      FakeSource.instances[0]?.onopen?.();
      FakeSource.instances[0]?.emit("stage", { run_id: "run-1", stage: "collect", status: "done" });
      FakeSource.instances[0]?.emit("source", { run_id: "run-1", source: "hackernews", status: "ok", items: 3 });
      FakeSource.instances[0]?.emit("done", { run_id: "run-1", status: "success" });
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.events.map((e) => e["stage"] ?? e["source"] ?? e["status"])).toEqual([
      "collect",
      "hackernews",
      "success",
    ]);
    expect(FakeSource.instances[0]?.closed).toBe(true);
  });
});
