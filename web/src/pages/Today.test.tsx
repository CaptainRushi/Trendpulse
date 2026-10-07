/**
 * Today page tests (docs/11 §6 + docs/07 UI IDs). Mock fetch serves the
 * API shapes; the component tree is real (router + query client + toast).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type React from "react";
import { Today } from "./Today.js";
import { ToastProvider } from "../components/Toast.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function topic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic_id: "t1",
    run_id: "run-1",
    run_date: "2026-09-30",
    rank: 1,
    title: "Alpha launch day",
    summary: "Alpha launched today with wide coverage.",
    category: "Tech",
    tags: ["launch"],
    trend_score: 92,
    score_engagement: 0.9,
    score_diversity: 0.5,
    score_relevance: 0.9,
    score_novelty: 0.8,
    momentum: "rising",
    sentiment: "positive",
    why_trending: "Launch coverage.",
    content_angles: ["Unboxing", "Review", "Comparisons"],
    evidence_item_ids: ["a1"],
    source_count: 2,
    top_urls: ["https://a.example.com/1"],
    jev_model: "stub",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00.000Z",
    is_latest: true,
    hidden: false,
    ...overrides,
  };
}

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

const DIGEST = {
  run_date: "2026-09-30",
  run_id: "run-1",
  digest: "Alpha launched. Beta rallied.",
  top_topic_id: "t1",
  topics_count: 2,
  items_count: 3,
  sources_ok: 2,
  sources_total: 2,
  top_categories: [{ category: "Tech", count: 1 }],
  created_at: "2026-09-30T07:00:00.000Z",
  is_latest: true,
};

function stubFetch(topics: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  const posts: { url: string; body: unknown }[] = [];
  const puts: { url: string; body: unknown }[] = [];
  let my = ["tech", "finance"];  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      seen.push(url);
      const path = new URL(url, "http://x").pathname;
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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
        my = body.my_categories;
        puts.push({ url, body });
        return json({ my_categories: my });
      }
      if (init?.method === "POST" && path === "/api/runs") {
        const body = readBody();
        posts.push({ url, body });
        return json({ run_id: "run-new" });
      }
      if (path === "/api/health") return json(HEALTH);
      if (path === "/api/my-categories") {
        return json({ my_categories: my, max_categories: 6, top_per_category: 5, include_general_sources: false });
      }
      if (path === "/api/today/categories") {
        return json({
          categories: [
            {
              category: "tech", status: "ok", last_run_at: "2026-09-30T06:02:00.000Z",
              sources: [{ name: "rss", status: "ok" }], stats: { items_collected: 1, items_kept: 1 },
              topics: topics.filter((t) => t["category"] === "Tech").map((t, i) => ({
                id: t["topic_id"], title: t["title"], summary: t["summary"], category: "tech",
                score: t["trend_score"], momentum: t["momentum"], source_count: t["source_count"], rank: i + 1,
              })),
            },
            {
              category: "finance", status: "ok", last_run_at: "2026-09-30T06:02:00.000Z",
              sources: [{ name: "rss", status: "ok" }], stats: { items_collected: 1, items_kept: 1 },
              topics: topics.filter((t) => t["category"] === "Finance").map((t, i) => ({
                id: t["topic_id"], title: t["title"], summary: t["summary"], category: "finance",
                score: t["trend_score"], momentum: t["momentum"], source_count: t["source_count"], rank: i + 1,
              })),
            },
          ],
        });
      }
      if (path === "/api/trends") {
        const params = new URL(url, "http://x").searchParams;
        const cats = params.getAll("category");
        const items = cats.length > 0 ? topics.filter((t) => cats.includes(String(t["category"]))) : topics;
        return json({ date: "2026-09-30", items, total: items.length, warnings: 0, cache: { age_s: 1 } });
      }
      if (path === "/api/digest") return json(DIGEST);
      if (path === "/api/dates") return json({ dates: ["2026-09-30"] });
      if (path === "/api/runs") return json({ runs: [], total: 0 });
      if (path === "/api/runs/active") return json({ run_id: null });
      if (path === "/api/runs/estimate") return json({ scope: "tech+finance", mode: "strict", sources: [], expected_new_items: 0, stored_items_reused: 0, jev_calls_expected: 0, writer_calls_expected: 0, cost_usd_estimate: 0, warnings: [], heuristic: true, per_category: [], general: { included: false, sources: [], expected_new_items: 0, jev_calls_expected: 0 } });
      if (path === "/api/jev/health") return json({ budget_used_usd: 0.31 });
      if (path.startsWith("/api/trends/")) {
        return json({
          topic: topics[0],
          evidence: [{ id: "a1", title: "Alpha launch day", url: "https://a.example.com/1" }],
          warnings: 0,
          cache: { age_s: 1 },
        });
      }
      return json({});
    }),
  );
  return seen;
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

const T2 = (): Record<string, unknown> =>
  topic({
    topic_id: "t2",
    rank: 2,
    title: "Beta markets rally",
    summary: "Markets rally on Beta news.",
    category: "Finance",
    trend_score: 61,
    momentum: "steady",
    content_angles: ["Index", "Winners", "Risks"],
    evidence_item_ids: [],
    source_count: 1,
    top_urls: [],
  });

describe("Today page", () => {
  it("UI-02 renders hero blocks and category panels from mock data", async () => {
    stubFetch([topic(), T2()]);
    renderToday();
    expect(await screen.findByText("today's trends")).not.toBeNull();
    for (const label of ["categories", "topics", "items", "ai cost"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    expect(await screen.findAllByText("Alpha launch day")).toHaveLength(2);
    expect(screen.getByText("Beta markets rally")).not.toBeNull();
    expect(await screen.findByLabelText("tech trends")).not.toBeNull();
    expect(screen.getByLabelText("finance trends")).not.toBeNull();
  });

  it("UI-03 my-category chips remove through the api", async () => {
    stubFetch([topic(), T2()]);
    renderToday();
    expect(await screen.findByText("Beta markets rally")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "remove tech" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "remove tech" })).toBeNull();
    });
  });

  it("UI-05 side panel shows score parts, angles and evidence links", async () => {
    stubFetch([topic(), T2()]);
    renderToday();
    fireEvent.click(await screen.findByRole("button", { name: /Alpha launch day/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("score breakdown");
    expect(dialog.textContent).toContain("Unboxing");
    expect(dialog.textContent).toContain("Launch coverage.");
    const link = await screen.findByRole("link", { name: "Alpha launch day" });
    expect(link.getAttribute("href")).toBe("https://a.example.com/1");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("UI-18 hostile titles render as inert text", async () => {
    stubFetch([topic({ title: '<img src=x onerror="alert(1)">', topic_id: "hx" })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Today />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findAllByText('<img src=x onerror="alert(1)">')).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
  });
});
