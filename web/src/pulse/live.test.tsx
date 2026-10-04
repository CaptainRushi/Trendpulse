/**
 * Pulse frontend tests (Doc 16 G4, PULSE-20..30 except e2e 31-33 which is G5).
 * Mock fetch serves the pulse shapes; EventSource is stubbed per test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type React from "react";
import { Today } from "../pages/Today.js";
import { LiveChart, SERIES_COLORS } from "../components/LiveChart.js";
import tokens from "../styles/tokens.json";
import { mergeSamplePoint } from "../hooks/useLive.js";
import type { PulseSeries } from "../lib/api";
import { ToastProvider } from "../components/Toast.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HEALTH = {
  ok: true,
  version: "t",
  setup_complete: true,
  sheets: "ok",
  omniroute: "ok",
  jev: "ok",
  next_run_at: null,
  last_run: null,
};

function pulseTop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-10-04",
    from_previous_day: false,
    topic: {
      topic_id: "t1",
      rank: 1,
      title: "Alpha launch day",
      summary: "Alpha launched today.",
      why_trending: "Launch coverage everywhere.",
      first_angle: "Unboxing frenzy",
      category: "Tech",
      momentum: "rising",
      score: 92,
      source_count: 3,
      items_count: 412,
      has_live_metric: true,
    },
    runner_ups: [],
    live: {
      enabled: true,
      last_sample_at: "2026-10-04T06:00:00.000Z",
      next_sample_at: "2026-10-04T06:20:00.000Z",
      interval_min: 20,
      status: "live",
    },
    ...overrides,
  };
}

function pulseSamples(): Record<string, unknown> {
  return {
    date: "2026-10-04",
    baseline_at: "2026-10-04T06:00:00.000Z",
    series: [
      {
        topic_id: "t1",
        title: "Topic 1",
        rank: 1,
        has_live_metric: true,
        sources: ["hackernews"],
        points: [
          { t: "2026-10-04T06:00:00.000Z", index: 100, total: 40 },
          { t: "2026-10-04T06:20:00.000Z", index: 154, total: 61.6 },
        ],
      },
      {
        topic_id: "t2",
        title: "Topic 2",
        rank: 2,
        has_live_metric: true,
        sources: ["github"],
        points: [
          { t: "2026-10-04T06:00:00.000Z", index: 100, total: 90000 },
          { t: "2026-10-04T06:20:00.000Z", index: 121, total: 108900 },
        ],
      },
    ],
  };
}

interface StubOptions {
  top?: Record<string, unknown>;
  topics?: Record<string, unknown>[];
}

function stubPulse(options: StubOptions = {}): void {
  const top = options.top ?? pulseTop();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      const path = new URL(url, "http://x").pathname;
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/health") return json(HEALTH);
      if (path === "/api/today/top") return json(top);
      if (path === "/api/live/samples") return json(pulseSamples());
      if (path === "/api/trends") return json({ date: "2026-10-04", items: options.topics ?? [], total: 0, warnings: 0, cache: { age_s: 1 } });
      if (path === "/api/digest") return json({ digest: "d", topics_count: 1, items_count: 1, sources_ok: 1, sources_total: 1 });
      if (path === "/api/dates") return json({ dates: ["2026-10-04"] });
      if (path === "/api/runs") return json({ runs: [], total: 0 });
      if (path === "/api/jev/health") return json({ budget_used_usd: 0 });
      return json({});
    }),
  );
}

function renderToday(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Today />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const SERIES = pulseSamples().series as PulseSeries[];

describe("PULSE-20 chart renders series, baseline and end labels", () => {
  it("draws two paths, the 100 line and direct labels", () => {
    const { container } = render(<LiveChart series={SERIES} mode="live" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 640 260");
    expect(svg?.getAttribute("aria-label")).toContain("Topic 1 +54");
    const labels = [...(container.querySelectorAll(".end-label") as unknown as Element[])].map((e) => e.textContent);
    expect(labels).toEqual(["Topic 1 +54%", "Topic 2 +21%"]);
    expect(container.querySelector(".baseline-line")).not.toBeNull();
  });

  it("scores mode renders bars instead of lines", () => {
    const { container } = render(
      <LiveChart series={SERIES} mode="scores" scores={[{ topic_id: "t1", title: "Topic 1", score: 92 }]} />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("92");
  });
});

describe("PULSE-21 legend toggle and keyboard crosshair", () => {
  it("hiding a series removes its path; arrows move the crosshair", () => {
    const { container } = render(<LiveChart series={SERIES} mode="live" />);
    const chip = screen.getByRole("button", { name: "Topic 2" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("Topic 2 +21%");
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("svg missing");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(container.querySelector(".chart-tooltip")?.textContent).toContain("index 100.0");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(container.querySelector(".chart-tooltip")?.textContent).toContain("index 154.0");
  });
});

describe("PULSE-22 hidden table equals the series data", () => {
  it("every point appears as a table row", () => {
    const { container } = render(<LiveChart series={SERIES} mode="live" />);
    const rows = container.querySelectorAll("table tbody tr");
    expect(rows.length).toBe(4);
    expect(container.textContent).toContain("2026-10-04T06:20:00.000Z");
  });
});

describe("PULSE-23 stream merge without refetch", () => {
  it("mergeSamplePoint appends, dedupes and caps at 300", () => {
    const one: PulseSeries = { topic_id: "t1", title: "T", rank: 1, has_live_metric: true, sources: [], points: [{ t: "t0", index: 100, total: 1 }] };
    const base = { date: "d", baseline_at: null, series: [one] };
    const merged = mergeSamplePoint(base, { topic_id: "t1", t: "t1", index: 110, total: 2 });
    expect(merged?.series[0]?.points).toHaveLength(2);
    const same = mergeSamplePoint(merged, { topic_id: "t1", t: "t1", index: 999, total: 9 });
    expect(same?.series[0]?.points).toHaveLength(2);
    expect(same?.series[0]?.points[1]?.index).toBe(110);
    const big = { ...base, series: [{ ...one, points: Array.from({ length: 300 }, (_, i) => ({ t: `t${String(i)}`, index: 100, total: 1 })) }] };
    const capped = mergeSamplePoint(big, { topic_id: "t1", t: "t-new", index: 200, total: 2 });
    expect(capped?.series[0]?.points).toHaveLength(300);
    expect(capped?.series[0]?.points[299]?.t).toBe("t-new");
    expect(mergeSamplePoint(undefined, { topic_id: "t1", t: "x", index: 1, total: 1 })).toBeUndefined();
  });
});

describe("PULSE-24 hero shows the top topic", () => {
  it("card, badge and scores toggle render from the route", async () => {
    stubPulse();
    renderToday();
    expect(await screen.findByText("top topic today")).not.toBeNull();
    expect(await screen.findByText("Alpha launch day")).not.toBeNull();
    expect(screen.getByText("Unboxing frenzy")).not.toBeNull();
    expect(await screen.findByText(/sampled/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "scores" }));
    expect(screen.getByText("92")).not.toBeNull();
  });
});

describe("PULSE-25 empty, no-live-metric and previous-day states", () => {
  it("empty hero nudges to runs", async () => {
    stubPulse({ top: pulseTop({ topic: null, runner_ups: [] }) });
    renderToday();
    expect(await screen.findByText("no top topic yet")).not.toBeNull();
    expect(screen.getByRole("link", { name: "run now" })).not.toBeNull();
  });

  it("no live metric shows the note and defaults to scores", async () => {
    const noMetric = pulseTop();
    (noMetric.topic as Record<string, unknown>)["has_live_metric"] = false;
    stubPulse({ top: noMetric });
    renderToday();
    expect(await screen.findByText(/no live numbers for this topic's sources/)).not.toBeNull();
    expect(screen.getByText("92")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "sample now" })).toBeNull();
  });

  it("previous-day fallback labels the date", async () => {
    stubPulse({ top: pulseTop({ from_previous_day: true, date: "2026-10-03" }) });
    renderToday();
    expect(await screen.findByText(/from 2026-10-03/)).not.toBeNull();
  });
});

describe("PULSE-26 hostile titles render as inert text", () => {
  it("hero title cannot inject markup", async () => {
    const evil = pulseTop();
    (evil.topic as Record<string, unknown>)["title"] = '<img src=x onerror="alert(1)">';
    stubPulse({ top: evil });
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const hi = sorted[0] ?? 0;
  const lo = sorted[1] ?? 0;
  return (hi + 0.05) / (lo + 0.05);
}

describe("PULSE-27 series colors meet contrast on the panel", () => {
  it("every stroke is at least 3:1 on white", () => {
    for (const color of SERIES_COLORS) {
      expect(contrast(color, tokens.panel)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("PULSE-28 reduced motion", () => {
  it("no flash class when the media query matches", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );
    stubPulse();
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Alpha launch day");
    expect(container.querySelector(".pulse-flash")).toBeNull();
  });
});

describe("PULSE-29 a11y scan of the section", () => {
  it("roles, labels, table, focus and live region are present", async () => {
    stubPulse();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Alpha launch day");
    const section = screen.getByRole("region", { name: "Top topic today" });
    expect(section.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(section.querySelector("svg")?.getAttribute("aria-label")).toContain("growth since baseline");
    expect(section.querySelector("table")).not.toBeNull();
    expect(section.querySelector("svg")?.getAttribute("tabindex")).toBe("0");
    expect(section.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(section.querySelector('[aria-label="live status"]')).not.toBeNull();
    expect(section.querySelector('[aria-label="Chart view"]')).not.toBeNull();
  });
});

describe("PULSE-30 narrow layout structure", () => {
  it("grid stacks by default and the svg scales", async () => {
    stubPulse();
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Alpha launch day");
    expect(container.querySelector(".pulse-grid")).not.toBeNull();
    const svg = container.querySelector(".live-chart svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 640 260");
    expect(svg?.getAttribute("width")).toBe("100%");
  });
});
