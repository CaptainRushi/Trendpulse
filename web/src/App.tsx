import type React from "react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  Compass,
  Database,
  Home,
  Moon,
  Play,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useHealth, useRuns, useStartRun, useSyncSheets } from "./hooks/useApi";
import { useTheme } from "./hooks/useTheme";
import { shiftAppDate, todayAppDate } from "./lib/format";
import { ToastProvider, useToast } from "./components/Toast";

const NAV = [
  { to: "/", label: "Today", icon: Home, end: true },
  { to: "/explore", label: "Explore", icon: Compass },
  { to: "/raw", label: "Raw Data", icon: Database },
  { to: "/sources", label: "Sources", icon: Server },
  { to: "/runs", label: "Runs", icon: Play },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function Shell(): React.JSX.Element {
  const health = useHealth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
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

  const date = params.get("date") ?? todayAppDate();
  const goDate = (next: string): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("date", next);
    setParams(nextParams, { replace: true });
  };

  const sync = useSyncSheets();
  const startRun = useStartRun();
  const runs = useRuns(1, 0);
  const latestStatus = runs.data?.runs[0]?.status;

  // First run → full-screen setup wizard (design §2), once health resolves.
  const setupComplete = health.data?.setup_complete;
  if (health.isPending) {
    return <div className="page" aria-label="Loading" />;
  }
  if (setupComplete === false && location.pathname !== "/wizard") {
    return <Navigate to="/wizard" replace />;
  }

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          <Compass size={20} aria-hidden="true" /> <span>TrendPulse</span>
        </div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end ?? false} className="nav-link">
            <item.icon size={20} aria-hidden="true" /> <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Previous day"
          onClick={() => { goDate(shiftAppDate(date, -1)); }}
        >
          ‹
        </button>
        <span aria-label="Current date">
          <CalendarDays size={16} aria-hidden="true" /> {date}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Next day"
          onClick={() => { goDate(shiftAppDate(date, 1)); }}
        >
          ›
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => { goDate(todayAppDate()); }}>
          Today
        </button>
        <input
          className="input"
          type="search"
          placeholder="Search (/ to focus)"
          aria-label="Search topics"
          value={params.get("q") ?? ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value) next.set("q", event.target.value);
            else next.delete("q");
            if (location.pathname !== "/") {
              void navigate({ pathname: "/", search: next.toString() });
            } else setParams(next, { replace: true });
          }}
        />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Sync with sheets"
          title="Sync"
          disabled={sync.isPending}
          onClick={() => {
            sync.mutate(undefined, {
              onSuccess: () => {
                toast({ tone: "good", message: "Synced with sheets." });
              },
              onError: (error) => {
                toast({ tone: "bad", message: error.message });
              },
            });
          }}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={startRun.isPending}
          onClick={() => {
            startRun.mutate(
              {},
              {
                onSuccess: (data) => {
                  toast({ tone: "good", message: "Run started." });
                  void navigate(`/runs/${data.run_id}`);
                },
                onError: (error) => {
                  toast({ tone: "bad", message: error.message });
                },
              },
            );
          }}
        >
          <Play size={16} aria-hidden="true" /> Run now
        </button>
        <span className="pill" data-tone={latestStatus === "success" ? "good" : latestStatus === "failed" ? "bad" : latestStatus === "running" ? "info" : undefined} aria-label={`Latest run: ${latestStatus ?? "none"}`}>
          <span className="dot" aria-hidden="true" /> {latestStatus ?? "idle"}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => { setTheme(theme === "dark" ? "light" : "dark"); }}
        >
          {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        </button>
      </header>

      <main className="main" id="main" tabIndex={-1}>
        {!online && (
          <div className="banner banner-warn" role="alert">
            You are offline — showing cached data.
          </div>
        )}
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="Sections">
        {NAV.slice(0, 5).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end ?? false}>
            <item.icon size={20} aria-hidden="true" /> {item.label}
          </NavLink>
        ))}
      </nav>
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
