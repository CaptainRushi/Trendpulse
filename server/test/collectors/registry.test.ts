import { describe, expect, it } from "vitest";
import { COLLECTORS, pingSource, runCollectors } from "../../src/collectors/registry.js";
import type { Collector, CollectResult } from "../../src/collectors/types.js";
import { makeCtx } from "./helpers.js";

/** A collector that always throws — used to prove isolation. */
const explosive: Collector = {
  key: "hackernews",
  label: "Explosive",
  requires: [],
  collect(): Promise<CollectResult> {
    return Promise.reject(new Error("collector exploded"));
  },
};

describe("runCollectors", () => {
  it("one throwing collector does not stop the others", async () => {
    // Monkey-patch one entry to throw; the rest run normally with no
    // configured sources (rss/webpage → skipped, others hit nothing → error
    // stats are fine — the point is NO rejection escapes Promise.all).
    const original = COLLECTORS.reddit;
    COLLECTORS.reddit = explosive;
    try {
      const ctx = makeCtx({
        fetchImpl: () =>
          Promise.resolve(new Response("offline", { status: 503 })),
        sleep: async () => undefined,
      });
      const out = await runCollectors(ctx, {
        keys: ["hackernews", "reddit", "rss", "webpage"],
      });
      const reddit = out.stats.find((s) => s.source === "reddit");
      expect(reddit?.status).toBe("error");
      expect(reddit?.error).toContain("exploded");
      // others still reported
      expect(out.stats.map((s) => s.source).sort()).toEqual([
        "hackernews",
        "reddit",
        "rss",
        "webpage",
      ]);
      expect(out.stats.find((s) => s.source === "rss")?.status).toBe("skipped");
      expect(out.stats.find((s) => s.source === "webpage")?.status).toBe("skipped");
    } finally {
      COLLECTORS.reddit = original;
    }
  });

  it("applies per-source limits and configs", async () => {
    const out = await runCollectors(makeCtx(), {
      keys: ["rss"],
      limits: { rss: 5 },
      configs: { rss: {} },
    });
    const rss = out.stats.find((s) => s.source === "rss");
    expect(rss?.status).toBe("skipped"); // config present but empty → still skipped
    expect(rss?.error).toContain("no feed URLs");
  });

  it("collects items across sources into one flat list", async () => {
    const out = await runCollectors(
      makeCtx({
        fetchImpl: () =>
          Promise.resolve(new Response("x", { status: 503 })),
        sleep: async () => undefined,
      }),
      { keys: ["hackernews", "google_trends"] },
    );
    expect(out.results.length).toBe(2);
    expect(out.items.length).toBe(0);
    expect(out.stats.every((s) => s.status === "error")).toBe(true);
  });
});

describe("registry completeness", () => {
  it("every source key resolves to a collector", () => {
    const keys = [
      "hackernews",
      "reddit",
      "google_trends",
      "github",
      "wikipedia",
      "rss",
      "webpage",
      "youtube",
      "producthunt",
      "devto",
    ];
    for (const key of keys) {
      expect(COLLECTORS[key as keyof typeof COLLECTORS]).toBeDefined();
    }
  });
});

describe("pingSource", () => {
  it("never throws; returns ok:false with detail for unreachable hosts", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const result = await pingSource("hackernews", ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("reports ok on a 200", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.resolve(new Response("[]", { status: 200 })),
    });
    const result = await pingSource("hackernews", ctx);
    expect(result).toEqual({ ok: true, detail: "HTTP 200" });
  });

  it("surfaces needsConfig for unconfigured sources", async () => {
    const ctx = makeCtx();
    const rss = await pingSource("rss", ctx);
    expect(rss.ok).toBe(false);
    expect(rss.detail).toContain("no feed URLs");
    const webpage = await pingSource("webpage", ctx);
    expect(webpage.ok).toBe(false);
    expect(webpage.detail).toContain("no page URLs");
  });
});
