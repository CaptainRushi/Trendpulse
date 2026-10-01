/**
 * Wizard state machine (§5.8): pure logic, DOM-free and unit-tested.
 * Progress persists to localStorage on every change so a refresh resumes
 * mid-wizard. Only non-secrets persist server-side (settings/sources APIs);
 * keys stay in the environment by design — the wizard tests them inline.
 */

export const WIZARD_STEPS = ["welcome", "sheets", "omniroute", "jev", "sources"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  step: number;
  sheets: { sheet_id: string; service_account_json: string };
  omniroute: { base_url: string; api_key: string };
  jev: { base_url: string; api_key: string; model: string };
  sources: { enabled: string[]; niches: string; cron: string };
  /** Probe outcomes this session (not persisted — re-test after reload). */
  tested: { sheets: boolean; omniroute: boolean; jev: boolean };
}

export const WIZARD_STORAGE_KEY = "trendpulse-wizard";

const DEFAULT_SOURCES = ["hackernews", "reddit", "google_trends", "github", "wikipedia", "rss", "webpage"];

export function defaultWizardState(): WizardState {
  return {
    step: 0,
    sheets: { sheet_id: "", service_account_json: "" },
    omniroute: { base_url: "http://localhost:20128/v1", api_key: "" },
    jev: { base_url: "", api_key: "", model: "" },
    sources: { enabled: [...DEFAULT_SOURCES], niches: "", cron: "0 6 * * *" },
    tested: { sheets: false, omniroute: false, jev: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse stored progress defensively — corrupt/old shapes fall back to defaults. */
export function loadWizardState(storage: Pick<Storage, "getItem">): WizardState {
  const fallback = defaultWizardState();
  let raw: string | null = null;
  try {
    raw = storage.getItem(WIZARD_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const step = typeof parsed["step"] === "number" ? parsed["step"] : 0;
  const pick = (section: string, defaults: Record<string, string>): Record<string, string> => {
    const node = parsed[section];
    if (!isRecord(node)) return { ...defaults };
    const out: Record<string, string> = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const value: unknown = node[key];
      out[key] = typeof value === "string" ? value : fallback;
    }
    return out;
  };
  const sourcesNode = isRecord(parsed["sources"]) ? parsed["sources"] : {};
  const enabled = Array.isArray(sourcesNode["enabled"])
    ? (sourcesNode["enabled"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [...DEFAULT_SOURCES];
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  return {
    step: Number.isInteger(step) && step >= 0 && step < WIZARD_STEPS.length ? step : 0,
    sheets: {
      sheet_id: "",
      service_account_json: "",
      ...pick("sheets", { sheet_id: "", service_account_json: "" }),
    },
    omniroute: {
      base_url: "http://localhost:20128/v1",
      api_key: "",
      ...pick("omniroute", { base_url: "", api_key: "" }),
    },
    jev: { base_url: "", api_key: "", model: "", ...pick("jev", { base_url: "", api_key: "", model: "" }) },
    sources: {
      enabled,
      niches: str(sourcesNode["niches"], ""),
      cron: str(sourcesNode["cron"], "0 6 * * *"),
    },
    tested: { sheets: false, omniroute: false, jev: false },
  };
}

export function saveWizardState(storage: Pick<Storage, "setItem">, state: WizardState): void {
  try {
    // Probe flags are session-only (re-test after reload); persist the rest.
    const persisted = {
      step: state.step,
      sheets: state.sheets,
      omniroute: state.omniroute,
      jev: state.jev,
      sources: state.sources,
    };
    storage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Private mode — the wizard still works, it just won't resume.
  }
}

export function clearWizardState(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(WIZARD_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Next is blocked until the step's test passes (welcome/sources have no
 * remote test: welcome is informational, sources validates locally).
 */
export function stepCanContinue(state: WizardState): boolean {
  const step = WIZARD_STEPS[state.step] ?? "welcome";
  switch (step) {
    case "welcome":
      return true;
    case "sheets":
      return state.tested.sheets;
    case "omniroute":
      return state.tested.omniroute;
    case "jev":
      return state.tested.jev;
    case "sources":
      return state.sources.cron.trim().length > 0;
  }
}
