/**
 * Today my-categories + panels tests (Doc 19 Q5, TOP5-21..25, TOP5-27, TOP5-28).
 * Mock fetch serves the API shapes; TOP5-26 (viewports) is Playwright in Q6.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Today } from "./Today.js";
import { ToastProvider } from "../components/Toast.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface PanelFixture {
  category: string;
  status: string;
  note?: string;
  topics: { id: string; title: string; summary: string; score: number; momentum: string; source_count: number; rank: number }[];
}

function panel(fixture: PanelFixture): Record<string, unknown> {
  return {
    category: fixture.category,
    status: fixture.status,
    last_run_at: "2026-09-30T06:02:00.000Z",
    sources: [{ name: "rss", status: "ok" }],
    stats: { items_collected: 3, items_kept: 3 },
    topics: fixture.topics.map((t) => ({ ...t, category: fixture.category, summary: t.summary })),
    ...(fixture.note ? { note: fixture.note } : {}),
  };
}

function topics(n: number, prefix: string, score = 90): PanelFixture["topics"] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-t${String(i)}`,
    title: `${prefix} title ${String(i)}`,
    summary: `${prefix} summary ${String(i)}.`,
    score: score - i,
    momentum: "rising",
    source_count: 2,
    rank: i + 1,
  }));
}

const HEALTH = {
  ok: true, version: "t", setup_complete: true, sheets: "ok", omniroute: "ok", jev: "ok",
  next_run_at: null, last_run: null,
};

const DIGEST = {
  run_date: "2026-09-30", run_id: "run-1", digest: "Ai rallied. Banks steadied.",
  top_topic_id: "ai-t0", topics_count: 7, items_count: 9, sources_ok: 2, sources_total: 2,
  top_categories: [{ category: "AI", count: 5 }], created_at: "2026-09-30T07:00:00.000Z", is_latest: true,
};

const ESTIMATE = {
  scope: "ai+finance", mode: "strict",
  sources: [{ collector: "rss", categories: ["ai", "finance"] }],
  expected_new_items: 80, stored_items_reused: 0, jev_calls_expected: 80,
  writer_calls_expected: 2, cost_usd_estimate: 0.0048, warnings: [], heuristic: true,
  per_category: [
    { category: "ai", sources: ["rss"], expected_new_items: 40, stored_items_reused: 0, jev_calls_expected: 40, writer_clusters_expected: 5 },
    { category: "finance", sources: ["rss"], expected_new_items: 40, stored_items_reused: 0, jev_calls_expected: 40, writer_clusters_expected: 5 },
  ],
  general: { included: false, sources: [], expected_new_items: 0, jev_calls_expected: 0 },
};

interface MockState {
  my: string[];
  panels: Record<string, unknown>[];
  posts: { url: string; body: unknown }[];
  puts: { url: string; body: unknown }[];
}

function stubApi(state: MockState): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const path = new URL(url, "http://x").pathname;
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      const readBody = (): unknown => {
        const raw = init?.body;
        if (typeof raw !== "string") return {};
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return {};
        }
      };
      if (init?.method === "PUT" && path === "/api/my-categories") {
        const body = readBody() as { my_categories: string[] };
        state.my = body.my_categories;
        state.puts.push({ url, body });
        return json({ my_categories: state.my });
      }
      if (init?.method === "POST" && path === "/api/runs") {
        const body = readBody();
        state.posts.push({ url, body });
        return json({ run_id: "run-new" });
      }
      if (path === "/api/health") return json(HEALTH);
      if (path === "/api/my-categories") {
        return json({ my_categories: state.my, max_categories: 6, top_per_category: 5, include_general_sources: false });
      }
      if (path === "/api/today/categories") {
        // The server returns one panel per selected category, in order.
        const panels = (state.panels as { category: string }[]).filter((p) => state.my.includes(p.category));
        panels.sort((a, b) => state.my.indexOf(a.category) - state.my.indexOf(b.category));
        return json({ categories: panels });
      }
      if (path === "/api/digest") return json(DIGEST);
      if (path === "/api/live/samples") {
        const category = new URL(url, "http://x").searchParams.get("category") ?? "";
        if (category === "ai") {
          return json({
            date: "2026-09-30", scope: "all", category, baseline_at: "2026-09-30T06:00:00.000Z",
            series: [
              {
                topic_id: "ai-t0", title: "ai title 0", rank: 1, has_live_metric: true, sources: ["rss"],
                points: [
                  { t: "2026-09-30T06:00:00.000Z", index: 100, total: 40 },
                  { t: "2026-09-30T06:20:00.000Z", index: 154, total: 61.6 },
                ],
              },
            ],
          });
        }
        return json({ date: "2026-09-30", scope: "all", category, baseline_at: null, series: [] });
      }
      if (path === "/api/runs") return json({ runs: [], total: 0 });
      if (path === "/api/runs/active") return json({ run_id: null });
      if (path === "/api/runs/estimate") return json(ESTIMATE);
      if (path === "/api/jev/health") return json({ budget_used_usd: 0.31 });
      if (path.startsWith("/api/trends/")) {
        const id = path.split("/").pop() ?? "";
        const found = state.panels
          .flatMap((p) => (p as { topics: { id: string; title: string; summary: string }[] }).topics)
          .find((t) => t.id === id);
        return json({
          topic: {
            topic_id: id, run_id: "run-1", run_date: "2026-09-30", rank: 1,
            title: found?.title ?? id, summary: found?.summary ?? "",
            category: "AI", tags: [], trend_score: 90, score_engagement: 0.8, score_diversity: 0.5,
            score_relevance: 0.8, score_novelty: 0.6, momentum: "rising", sentiment: "neutral",
            why_trending: "Coverage.", content_angles: ["Angle one"], evidence_item_ids: ["a1"],
            source_count: 2, top_urls: [], jev_model: "stub", prompt_version: "v1",
            sorted_at: "2026-09-30T07:00:00.000Z", is_latest: true, hidden: false,
          },
          evidence: [{ id: "a1", title: "Alpha launch day", url: "https://a.example.com/1" }],
          warnings: 0, cache: { age_s: 1 },
        });
      }
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

function fullState(): MockState {
  return {
    my: ["ai", "finance"],
    panels: [
      panel({ category: "ai", status: "ok", topics: topics(5, "ai") }),
      panel({ category: "finance", status: "ok", topics: topics(2, "fin"), note: "only 2 topics found · sources may be thin" }),
      panel({ category: "science", status: "ok", topics: [] }),
    ],
    posts: [],
    puts: [],
  };
}

describe("TOP5-21 chip add, remove, reorder and persistence", () => {
  it("edits save immediately and survive refetch", async () => {
    const state = fullState();
    stubApi(state);
    renderToday();
    await screen.findByRole("button", { name: "remove ai" });
    fireEvent.click(screen.getByRole("button", { name: "remove ai" }));
    await waitFor(() => {
      expect(state.puts.some((p) => JSON.stringify(p.body).includes('"my_categories":["finance"]'))).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "remove ai" })).toBeNull();
    // Add science through the menu, then move it left (reorder).
    fireEvent.change(screen.getByRole("combobox", { name: "add a category" }), { target: { value: "science" } });
    await waitFor(() => {
      expect(state.my).toEqual(["finance", "science"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "move science left" }));
    await waitFor(() => {
      expect(state.my).toEqual(["science", "finance"]);
    });
    expect(state.puts.length).toBeGreaterThanOrEqual(3);
    // Panels follow the persisted order.
    const sections = await screen.findAllByLabelText(/^[a-z]+ trends$/);
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["science trends", "finance trends"]);
  });
});

describe("TOP5-22 onboarding when empty", () => {
  it("pick-your-categories card saves a selection", async () => {
    const state: MockState = { my: [], panels: [], posts: [], puts: [] };
    stubApi(state);
    renderToday();
    expect(await screen.findByText("pick your categories")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ai" }));
    fireEvent.click(screen.getByRole("button", { name: "finance" }));
    fireEvent.click(screen.getByRole("button", { name: /save 2 categories/ }));
    await waitFor(() => {
      expect(state.my).toEqual(["ai", "finance"]);
    });
  });
});

describe("TOP5-23 panels show at most TOP_PER_CATEGORY rows with notes", () => {
  it("thin, hidden, failed and no-source notes render", async () => {
    const state: MockState = {
      my: ["ai", "finance", "science", "other"],
      panels: [
        panel({ category: "ai", status: "ok", topics: topics(2, "ai"), note: "only 2 topics found · sources may be thin" }),
        panel({ category: "finance", status: "ok", topics: topics(5, "fin"), note: "1 topic hidden by you" }),
        { ...panel({ category: "science", status: "failed", topics: [] }), note: "failed: feed 500, retry" },
        { ...panel({ category: "other", status: "no_sources", topics: [] }), note: "no usable sources, edit sources in settings" },
      ],
      posts: [],
      puts: [],
    };
    stubApi(state);
    renderToday();
    const aiPanel = await screen.findByLabelText("ai trends");
    expect(within(aiPanel).getAllByRole("button", { name: /Open / })).toHaveLength(2);
    expect(within(aiPanel).getByText(/sources may be thin/)).not.toBeNull();
    expect(screen.getByText(/1 topic hidden by you/)).not.toBeNull();
    expect(screen.getByText(/failed: feed 500, retry/)).not.toBeNull();
    expect(screen.getByText(/no usable sources, edit sources in settings/)).not.toBeNull();
    const finPanel = screen.getByLabelText("finance trends");
    expect(within(finPanel).getAllByRole("button", { name: /Open / })).toHaveLength(5);
  });
});

describe("TOP5-24 per-panel refresh affects only that panel", () => {
  it("refresh finance posts only finance", async () => {
    const state = fullState();
    stubApi(state);
    renderToday();
    fireEvent.click(await screen.findByRole("button", { name: "refresh finance" }));
    await waitFor(() => {
      expect(state.posts).toHaveLength(1);
    });
    const post = state.posts[0] as { url: string; body: unknown };
    expect(post.url).toContain("/api/runs");
    expect(post.body).toEqual({ categories: ["finance"] });
  });
});

describe("TOP5-25 estimate popover", () => {
  it("shows the per-category estimate", async () => {
    const state = fullState();
    stubApi(state);
    renderToday();
    fireEvent.click(await screen.findByRole("button", { name: /estimate/ }));
    const dialog = await screen.findByRole("dialog", { name: "run estimate" });
    expect(dialog.textContent).toContain("ai:");
    expect(dialog.textContent).toContain("finance:");
    expect(dialog.textContent).toContain("0.0048");
  });
});

describe("TOP5-27 keyboard and live announcements", () => {
  it("chips and refresh buttons are keyboard reachable; finishes announce", async () => {
    const state = fullState();
    stubApi(state);
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
    const remove = await screen.findByRole("button", { name: "remove ai" });
    remove.focus();
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(remove, { key: "Enter" });
    const refresh = await screen.findByRole("button", { name: "refresh ai" });
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    // A running panel finishing announces politely.
    const running = {
      ...panel({ category: "ai", status: "running", topics: [] }),
    };
    client.setQueryData(["today-categories"], { categories: [running, state.panels[1]] });
    await waitFor(() => {
      expect(screen.queryByLabelText("ai trends")).not.toBeNull();
    });
    client.setQueryData(["today-categories"], { categories: [state.panels[0], state.panels[1]] });
    await waitFor(() => {
      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toContain("ai finished (ok)");
    });
  });
});

describe("TOP5-28 hostile titles inert", () => {  it("panel rows render hostile text without elements", async () => {
    const state: MockState = {
      my: ["ai"],
      panels: [
        panel({
          category: "ai",
          status: "ok",
          topics: [{ id: "hx", title: '<img src=x onerror="alert(1)">', summary: "x", score: 90, momentum: "new", source_count: 1, rank: 1 }],
        }),
      ],
      posts: [],
      puts: [],
    };
    stubApi(state);
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findAllByText('<img src=x onerror="alert(1)">')).toHaveLength(3);
    expect(container.querySelector("img")).toBeNull();
  });
});
describe("TOP5-30 live graph shows one series per category number one", () => {
  it("charts sampled number ones; unsampled categories get a note", async () => {
    const state = fullState();
    stubApi(state);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Live growth" });
    await waitFor(() => {
      expect(section.querySelector("svg")?.getAttribute("aria-label")).toContain("ai title 0 +54");
    });
    expect(section.textContent).toContain("finance #1 has no live numbers yet");
  });
});
