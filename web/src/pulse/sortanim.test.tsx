/**
 * Sorting animation + picker tests (Doc 17 S5, SORTANIM-05..11, SORTANIM-14).
 * sort-state snapshots drive the component; EventSource is absent in JSDOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type React from "react";
import { SortingStage } from "../components/SortingStage.js";
import { CategoryPicker } from "../components/CategoryPicker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function snapshot(events: Record<string, unknown>[], phase: string | null = null): Record<string, unknown> {
  return { phase, events };
}

function batch(ids: string[], category: string): Record<string, unknown> {
  return {
    type: "sort_batch",
    stage: "classify",
    items: ids.map((id) => ({ id, t: `Title ${id}`, c: category, q: 0.9, f: false, d: false, o: false })),
    done: ids.length,
    total: ids.length,
    jev_calls: ids.length,
    fallback_calls: 0,
    cost_usd: 0.001,
  };
}

function stubSortState(events: Record<string, unknown>[], phase: string | null = "classify"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      const path = new URL(url, "http://x").pathname;
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.endsWith("/sort-state")) return json(snapshot(events, phase));
      return json({});
    }),
  );
}

function renderStage(runId = "run-1", compact = false): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SortingStage runId={runId} compact={compact} />
    </QueryClientProvider>,
  );
}

const AI_IDS = ["a1", "a2", "a3"];

describe("SORTANIM-05 phase rendering from event fixtures", () => {
  it("bins fill from sort_batch; clusters/topics/ranks build cards", async () => {
    stubSortState([
      batch(AI_IDS, "ai"),
      { type: "sort_clusters", clusters: [{ id: "c1", category: "ai", size: 3, member_ids: AI_IDS }] },
      { type: "sort_topics", topics: [{ cluster_id: "c1", title: "AI group" }] },
      { type: "sort_rank", ranks: [{ cluster_id: "c1", rank: 1, score: 92 }] },
    ], "done");
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" />
          </QueryClientProvider>
        );
      })(),
    );
    expect(await screen.findByText(/classify 3\/3/)).not.toBeNull();
    await waitFor(() => {
      const el = screen.getByRole("region", { name: "Sorting progress" });
      expect(el.textContent).toContain("AI group");
    });
  });
});

describe("SORTANIM-06 bin counts and the 150 cap", () => {
  it("shows +n past the cap", async () => {
    const ids = Array.from({ length: 160 }, (_, i) => `i${String(i)}`);
    stubSortState([batch(ids, "tech")]);
    renderStage();
    await screen.findByText("+10 more");
  });
});

describe("SORTANIM-07 FLIP final order and top highlight", () => {
  it("cards sort by rank with the top card marked", async () => {
    stubSortState([
      batch(["x", "y"], "ai"),
      { type: "sort_clusters", clusters: [{ id: "c1", category: "ai", size: 2, member_ids: ["x", "y"] }] },
      { type: "sort_topics", topics: [{ cluster_id: "c1", title: "Winner" }] },
      { type: "sort_rank", ranks: [{ cluster_id: "c1", rank: 1, score: 95 }] },
    ]);
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" />
          </QueryClientProvider>
        );
      })(),
    );
    const region = await screen.findByRole("region", { name: "Sorting progress" });
    await waitFor(() => {
      expect(region.textContent).toContain("Winner");
    });
    expect(container.querySelector('[data-top="true"]')).not.toBeNull();
  });
});

describe("SORTANIM-08 reduced motion", () => {
  it("renders counters only, no animated dots", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );
    stubSortState([batch(AI_IDS, "ai")]);
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" />
          </QueryClientProvider>
        );
      })(),
    );
    await screen.findByText(/classify 3\/3/);
    expect(container.querySelector(".sort-dots")).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });
});

describe("SORTANIM-09 a11y paths", () => {
  it("region, live announcements, keyboard bins, inert titles", async () => {
    stubSortState([batch(["h1"], "ai")]);
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" />
          </QueryClientProvider>
        );
      })(),
    );
    const region = await screen.findByRole("region", { name: "Sorting progress" });
    expect(region.querySelector('[aria-live="polite"]')).not.toBeNull();
    const bin = screen.getByRole("button", { name: /ai: 1 items/ });
    fireEvent.keyDown(bin, { key: "Enter" });
    expect(await screen.findByText("Title h1")).not.toBeNull();
  });

  it("hostile titles stay inert", async () => {
    stubSortState([
      {
        type: "sort_batch",
        stage: "classify",
        items: [{ id: "x", t: '<img src=x onerror="alert(1)">', c: "ai", q: 0.9, f: false, d: false, o: false }],
        done: 1,
        total: 1,
        jev_calls: 1,
        fallback_calls: 0,
        cost_usd: 0,
      },
    ]);
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" />
          </QueryClientProvider>
        );
      })(),
    );
    const region = await screen.findByRole("region", { name: "Sorting progress" });
    expect(region.textContent).not.toContain("alert(1)");
    fireEvent.click(screen.getByRole("button", { name: /ai: 1 items/ }));
    const titles = await screen.findByRole("list", { name: /Latest titles/ });
    expect(titles.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("SORTANIM-11 compact variant and replay", () => {
  it("compact hides dots; replay rebuilds without crashing", async () => {
    stubSortState([batch(AI_IDS, "ai")]);
    const { container } = render(
      (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={client}>
            <SortingStage runId="run-1" compact />
          </QueryClientProvider>
        );
      })(),
    );
    await screen.findByText(/classify 3\/3/);
    expect(container.querySelector(".sort-dots")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "replay" }));
    await waitFor(() => {
      expect(screen.getByText(/classify 3\/3/)).not.toBeNull();
    });
  });
});

describe("SORTANIM-14 picker behavior", () => {
  function renderPicker(selected: string[], onChange: (s: string[], m: "strict" | "loose") => void): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CategoryPicker selected={selected} mode="strict" onChange={onChange} onRun={() => undefined} running={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("multi-select up to 5, estimate popover, strict/loose, defaults link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        const path = new URL(url, "http://x").pathname;
        const json = (body: unknown): Response =>
          new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (path === "/api/categories") {
          return json({ categories: [{ slug: "ai", label: "AI" }, { slug: "finance", label: "Finance" }], default_categories: [] });
        }
        if (path === "/api/runs/estimate") {
          return json({ scope: "ai", mode: "strict", sources: [{ collector: "rss", categories: ["ai"] }], expected_new_items: 10, stored_items_reused: 5, jev_calls_expected: 10, cost_usd_estimate: 0.0006, warnings: [] });
        }
        return json({});
      }),
    );
    const seen: { selected: string[]; mode: string }[] = [];
    renderPicker(["ai"], (s, m) => {
      seen.push({ selected: s, mode: m });
    });
    expect(await screen.findByRole("button", { name: "ai ×" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "finance" }));
    expect(seen).toEqual([{ selected: ["ai", "finance"], mode: "strict" }]);
    fireEvent.click(screen.getByRole("button", { name: "loose" }));
    expect(seen[1]).toEqual({ selected: ["ai"], mode: "loose" });
    expect(screen.getByRole("link", { name: /default categories/ }).getAttribute("href")).toBe("/settings");
    fireEvent.click(screen.getByRole("button", { name: "estimate" }));
    expect(await screen.findByText(/10 new items/)).not.toBeNull();
  });
});
