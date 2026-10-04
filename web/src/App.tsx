import type React from "react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useHealth, useRuns, useSheetLink, useStartRun, useSyncSheets } from "./hooks/useApi";
import { ToastProvider, useToast } from "./components/Toast";
import { Pill } from "./components/decode";

const NAV = [
  { to: "/", label: "today", end: true },
  { to: "/runs", label: "runs" },
  { to: "/sources", label: "sources" },
  { to: "/raw", label: "raw" },
  { to: "/settings", label: "settings" },
];

function Shell(): React.JSX.Element {
  const health = useHealth();
  const navigate = useNavigate();
  const toast = useToast();
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const onOnline = (): void => {
      setOnline(true);
    };
    const onOffline = (): void => {
      setOnline(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const sync = useSyncSheets();
  const startRun = useStartRun();
  const runs = useRuns(1, 0);
  const latestStatus = runs.data?.runs[0]?.status;
  const sheetLink = useSheetLink();

  return (
    <div className="wrap">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="bar" aria-label="Primary">
        <NavLink to="/" className="bar-brand">
          <img src="/logo.svg" alt="" width={22} height={22} aria-hidden="true" />
          Trendpulse
        </NavLink>
        <div className="bar-links">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end ?? false}>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="bar-actions">
          {sheetLink.data ? (
            <a href={sheetLink.data.spreadsheet_url} target="_blank" rel="noopener noreferrer" aria-label="Open sheet">
              sheet ↗
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={sync.isPending}
            onClick={() => {
              sync.mutate(undefined, {
                onSuccess: () => {
                  toast({ tone: "good", message: "synced." });
                },
                onError: (error) => {
                  toast({ tone: "bad", message: error.message });
                },
              });
            }}
          >
            sync
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ minHeight: 38 }}
            disabled={startRun.isPending}
            onClick={() => {
              startRun.mutate(
                {},
                {
                  onSuccess: (data) => {
                    toast({ tone: "good", message: "run started." });
                    void navigate(`/runs/${data.run_id}`);
                  },
                  onError: (error) => {
                    toast({ tone: "bad", message: error.message });
                  },
                },
              );
            }}
          >
            run now
          </button>
          <Pill
            tone={latestStatus === "success" ? "good" : latestStatus === "failed" ? "bad" : latestStatus === "running" ? "info" : undefined}
            label={`latest run: ${latestStatus ?? "none"}`}
          >
            {latestStatus ?? "idle"}
          </Pill>
        </div>
      </nav>

      <main className="page" id="main" tabIndex={-1}>
        {!online && (
          <div className="banner banner-warn" role="alert">
            offline — showing cached data.
          </div>
        )}
        {health.isError ? (
          <div className="banner banner-warn" role="alert">
            cannot reach the server — is trendpulse running?
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
