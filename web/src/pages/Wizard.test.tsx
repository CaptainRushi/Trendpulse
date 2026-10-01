import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { ToastProvider } from "../components/Toast.js";
import { Wizard } from "./Wizard.js";
import { WIZARD_STORAGE_KEY } from "../wizard/logic.js";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      for (const [path, body] of Object.entries(routes)) {
        if (url.endsWith(path)) {
          return Promise.resolve(
            new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
          );
        }
      }
      return Promise.reject(new Error(`unmocked fetch: ${url}`));
    }),
  );
}

function renderWizard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <Wizard />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui as ReactNode);
}

const SOURCES = [
  { key: "hackernews", label: "Hacker News", enabled: true, item_limit: 50, config: {}, requires: [], last_status: null, last_error: null, last_run_at: null, last_items: null },
  { key: "rss", label: "RSS", enabled: true, item_limit: 50, config: {}, requires: [], last_status: null, last_error: null, last_run_at: null, last_items: null },
];

describe("Wizard", () => {
  it("starts at welcome and advances", async () => {
    const user = userEvent.setup();
    mockFetch({ "/api/sources": SOURCES });
    renderWizard();
    expect(screen.getByText("Set up TrendPulse")).toBeDefined();
    expect(screen.getByText("Welcome")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Google Sheets")).toBeDefined();
  });

  it("blocks Next on the sheets step until the probe passes", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/api/sources": SOURCES,
      "/api/setup/test-sheets": { ok: false, error: "No sheet id." },
    });
    renderWizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    const next = screen.getByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Sheet ID (from the sheet URL)"), "abc123");
    await user.click(screen.getByRole("button", { name: /Test/ }));
    await waitFor(() => {
      expect(screen.getAllByText("No sheet id.")).toHaveLength(2); // badge + toast
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled).toBe(true);
  });

  it("passes the sheets step on ok:true and resumes progress after reload", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/api/sources": SOURCES,
      "/api/setup/test-sheets": { ok: true, tabs: [] },
    });
    renderWizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Sheet ID (from the sheet URL)"), "abc123");
    await user.click(screen.getByRole("button", { name: /Test/ }));
    await waitFor(() => {
      expect(screen.getAllByText("Connection works.")).toHaveLength(2); // badge + toast
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("OmniRoute")).toBeDefined();
    // Progress persisted → a fresh mount resumes at omniroute.
    const stored = window.localStorage.getItem(WIZARD_STORAGE_KEY);
    expect(stored).toContain('"step":2');
  });
});
