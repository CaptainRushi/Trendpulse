/** Theme: dark-first, light supported, persisted locally + to settings. */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

export type Theme = "dark" | "light";

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem("trendpulse-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Private mode — fall through to dark-first.
  }
  return "dark";
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    try {
      window.localStorage.setItem("trendpulse-theme", theme);
    } catch {
      // Ignore persistence failures.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    // Best-effort mirror into server settings (wizard consistency).
    void api.put("/api/settings", { theme: next }).catch(() => undefined);
  }, []);

  return [theme, setTheme];
}
