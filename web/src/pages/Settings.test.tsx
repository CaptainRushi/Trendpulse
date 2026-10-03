/**
 * UI-11: settings saves stay disabled until the connection test passes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type React from "react";
import { Settings } from "./Settings.js";
import { ToastProvider } from "../components/Toast.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SETTINGS = {
  settings: {
    google_service_account: { value: "", is_set: false, secret: true, source: "env" },
    sheet_id: { value: "", is_set: false, secret: false, source: "default" },
    omniroute_api_key: { value: "", is_set: false, secret: true, source: "env" },
    jev_api_key: { value: "", is_set: false, secret: true, source: "env" },
    schedule_cron: { value: "0 6 * * *", is_set: true, secret: false, source: "env" },
    niches: { value: [], is_set: false, secret: false, source: "default" },
  },
};

describe("Settings page", () => {
  it("UI-11 save stays gated until the connection test passes", async () => {
    const seen: { method: string; url: string; body?: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = typeof input === "string" ? input : String(input);
        seen.push({ method: init?.method ?? "GET", url, body: init?.body });
        const json = (body: unknown): Response =>
          new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (url === "/api/settings" && (init?.method ?? "GET") === "GET") return json(SETTINGS);
        if (url === "/api/setup/test-sheets") return json({ ok: true, service_account_email: "bot@x", tabs: [] });
        if (url === "/api/settings") return json({ updated: ["schedule_cron"], scheduler_restarted: false });
        return json({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/settings"]}>
            <Settings />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    const save = await screen.findByRole("button", { name: "save schedule" });
    expect(save.hasAttribute("disabled")).toBe(true);

    const tests = await screen.findAllByRole("button", { name: "test connection" });
    fireEvent.click(tests[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "save schedule" }).hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "save schedule" }));
    await waitFor(() => {
      const put = seen.find((r) => r.method === "PUT" && r.url === "/api/settings");
      expect(put?.body).toContain("schedule_cron");
    });
  });
});
