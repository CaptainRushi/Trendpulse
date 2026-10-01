import type React from "react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import type { SettingView } from "../lib/api.js";
import { useSettings } from "../hooks/useApi.js";
import { useTheme } from "../hooks/useTheme.js";
import { useToast } from "../components/Toast.js";
import { ErrorState, SkeletonGrid } from "../components/States.js";

const TABS = ["Connections", "Schedule", "Sorting", "Data", "Appearance", "Security"] as const;

/** Settings (§5.7): tabbed forms over the settings API + probe buttons. */
export function Settings(): React.JSX.Element {
  const settings = useSettings();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Connections");

  if (settings.isPending) {
    return (
      <div className="page">
        <SkeletonGrid count={2} />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="page">
        <ErrorState error={settings.error} />
      </div>
    );
  }
  return (
    <div className="page">
      <h1 style={{ margin: 0 }}>Settings</h1>
      <div role="tablist" aria-label="Settings sections" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className="chip"
            aria-pressed={tab === name}
            onClick={() => { setTab(name); }}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "Connections" ? <Connections /> : null}
      {tab === "Schedule" ? <Schedule /> : null}
      {tab === "Sorting" ? <Sorting /> : null}
      {tab === "Data" ? <DataTab /> : null}
      {tab === "Appearance" ? <Appearance /> : null}
      {tab === "Security" ? <Security /> : null}
    </div>
  );
}

function settingValue(view: Record<string, SettingView>, key: string): unknown {
  const entry: SettingView | undefined = view[key];
  return entry?.value;
}

function useSave(): {
  save: (values: Record<string, unknown>, okMessage: string) => void;
  pending: boolean;
} {
  const toast = useToast();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  return {
    pending,
    save: (values, okMessage) => {
      setPending(true);
      api
        .put("/api/settings", values)
        .then(() => {
          void client.invalidateQueries({ queryKey: ["settings"] });
          toast({ tone: "good", message: okMessage });
        })
        .catch((error: unknown) => {
          toast({ tone: "bad", message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          setPending(false);
        });
    },
  };
}

function Connections(): React.JSX.Element {
  const settings = useSettings();
  const toast = useToast();
  const [sheets, setSheets] = useState({ sheet_id: "", service_account_json: "" });
  const [omni, setOmni] = useState({ base_url: "", api_key: "" });
  const [jev, setJev] = useState({ base_url: "", api_key: "", model: "" });
  const [result, setResult] = useState("");

  const test = (label: string, path: string, body: unknown): void => {
    setResult(`${label}: testing…`);
    api
      .post<{ ok: boolean; error?: string; models?: string[]; model?: string }>(path, body)
      .then((res) => {
        setResult(
          res.ok
            ? `${label}: ok${res.models ? ` (${res.models.join(", ")})` : ""}${res.model ? ` (${res.model})` : ""}`
            : `${label}: ${res.error ?? "failed"}`,
        );
        toast({
          tone: res.ok ? "good" : "bad",
          message: res.ok ? `${label} works.` : (res.error ?? `${label} failed.`),
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setResult(`${label}: ${message}`);
        toast({ tone: "bad", message });
      });
  };

  const view = settings.data?.settings ?? {};
  const secret = (key: string): string => {
    const entry = view[key];
    if (entry && typeof entry === "object" && "is_set" in entry) {
      return (entry as { is_set: boolean }).is_set ? "set" : "not set";
    }
    return "not set";
  };

  return (
    <>
      <section className="card" aria-label="Google Sheets connection">
        <strong>Google Sheets</strong>
        <span className="badge">service account: {secret("google_service_account")}</span>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="conn-sheet-id">Sheet ID</label>
            <input id="conn-sheet-id" className="input" value={sheets.sheet_id} onChange={(e) => {
              setSheets({ ...sheets, sheet_id: e.target.value });
            }} placeholder="From settings or paste here" />
          </div>
          <div className="form-field">
            <label htmlFor="conn-sa">Service account JSON (optional override)</label>
            <textarea id="conn-sa" className="input" rows={3} value={sheets.service_account_json} onChange={(e) => {
              setSheets({ ...sheets, service_account_json: e.target.value });
            }} placeholder="Paste key JSON to test without saving" />
          </div>
          <div>
            <button type="button" className="btn btn-ghost" onClick={() => {
              test("Sheets", "/api/setup/test-sheets", { sheet_id: sheets.sheet_id || undefined, ...(sheets.service_account_json ? { service_account_json: sheets.service_account_json } : {}) });
            }}>
              Test &amp; create tabs
            </button>
          </div>
        </div>
      </section>

      <section className="card" aria-label="OmniRoute connection">
        <strong>OmniRoute</strong>
        <span className="badge">api key: {secret("omniroute_api_key")}</span>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="conn-omni-url">Base URL</label>
            <input id="conn-omni-url" className="input" value={omni.base_url} onChange={(e) => {
              setOmni({ ...omni, base_url: e.target.value });
            }} placeholder="http://localhost:20128/v1" />
          </div>
          <div className="form-field">
            <label htmlFor="conn-omni-key">API key</label>
            <input id="conn-omni-key" className="input" type="password" autoComplete="off" value={omni.api_key} onChange={(e) => { setOmni({ ...omni, api_key: e.target.value }); }} />
          </div>
          <div>
            <button type="button" className="btn btn-ghost" onClick={() => {
              test("OmniRoute", "/api/setup/test-omniroute", { base_url: omni.base_url, api_key: omni.api_key || undefined });
            }}>
              Test
            </button>
          </div>
        </div>
      </section>

      <section className="card" aria-label="Jev connection">
        <strong>Jev</strong>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="conn-jev-url">Base URL (empty = ride OmniRoute)</label>
            <input id="conn-jev-url" className="input" value={jev.base_url} onChange={(e) => { setJev({ ...jev, base_url: e.target.value }); }} />
          </div>
          <div className="form-field">
            <label htmlFor="conn-jev-model">Model</label>
            <input
              id="conn-jev-model"
              className="input"
              value={jev.model}
              onChange={(e) => { setJev({ ...jev, model: e.target.value }); }}
            />
          </div>
          <div className="form-field">
            <label htmlFor="conn-jev-key">API key</label>
            <input id="conn-jev-key" className="input" type="password" autoComplete="off" value={jev.api_key} onChange={(e) => { setJev({ ...jev, api_key: e.target.value }); }} />
          </div>
          <div>
            <button type="button" className="btn btn-ghost" onClick={() => {
              test("Jev", "/api/setup/test-jev", { base_url: jev.base_url || undefined, api_key: jev.api_key || undefined, model: jev.model });
            }}>
              Test with sample
            </button>
          </div>
        </div>
      </section>
      <div className="badge" role="status">{result || "No test run yet."}</div>
    </>
  );
}

/** "0 6 * * *" → "Every day at 06:00"; anything else shown raw. */
export function humanizeCron(cron: string): string {
  const match = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return `Every day at ${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  }
  return cron;
}

function Schedule(): React.JSX.Element {
  const settings = useSettings();
  const { save, pending } = useSave();
  const view = settings.data?.settings ?? {};
  const cronValue = settingValue(view, "schedule_cron");
  const current = typeof cronValue === "string" ? cronValue : "0 6 * * *";
  const [cron, setCron] = useState(current);
  const [missed, setMissed] = useState<boolean | null>(null);
  const rawMissed = settingValue(view, "run_missed_on_start");
  const missedValue = missed ?? (typeof rawMissed === "boolean" ? rawMissed : true);

  return (
    <section className="card" aria-label="Schedule">
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="sched-cron">Cron schedule</label>
          <input id="sched-cron" className="input mono" value={cron} onChange={(e) => { setCron(e.target.value); }} />
          <span className="form-hint">{humanizeCron(cron)} (hot-reloads the scheduler on save)</span>
        </div>
        <label>
          <input type="checkbox" checked={missedValue} onChange={(e) => { setMissed(e.target.checked); }} /> Run missed on
          start (catch up overnight gaps)
        </label>
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={() => { save({ schedule_cron: cron, run_missed_on_start: missedValue }, "Schedule saved."); }}
          >
            Save schedule
          </button>
        </div>
      </div>
    </section>
  );
}

function Sorting(): React.JSX.Element {
  const settings = useSettings();
  const { save, pending } = useSave();
  const view = settings.data?.settings ?? {};
  const num = (key: string, fallback: number): number => {
    const value = settingValue(view, key);
    return typeof value === "number" ? value : fallback;
  };
  const weightsValue = settingValue(view, "score_weights");
  const weights =
    typeof weightsValue === "object" && weightsValue !== null
      ? (weightsValue as { engagement?: unknown; diversity?: unknown; relevance?: unknown; novelty?: unknown })
      : undefined;
  const percent = (part: unknown, fallback: number): number =>
    typeof part === "number" ? Math.round(part * 100) : fallback;
  const [batch, setBatch] = useState(num("sort_batch_size", 30));
  const [topN, setTopN] = useState(num("top_n", 50));
  const [parts, setParts] = useState({
    engagement: percent(weights?.engagement, 35),
    diversity: percent(weights?.diversity, 25),
    relevance: percent(weights?.relevance, 25),
    novelty: percent(weights?.novelty, 15),
  });
  const sum = parts.engagement + parts.diversity + parts.relevance + parts.novelty;

  return (
    <section className="card" aria-label="Sorting">
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="sort-batch">Batch size</label>
          <input id="sort-batch" className="input" type="number" min={1} style={{ width: 120 }} value={batch} onChange={(e) => { setBatch(Number(e.target.value)); }} />
        </div>
        <div className="form-field">
          <label htmlFor="sort-topn">Top N</label>
          <input id="sort-topn" className="input" type="number" min={1} style={{ width: 120 }} value={topN} onChange={(e) => { setTopN(Number(e.target.value)); }} />
        </div>
        {(Object.keys(parts) as (keyof typeof parts)[]).map((key) => (
          <div className="form-field" key={key}>
            <label htmlFor={`w-${key}`}>
              {key} ({parts[key]}%)
            </label>
            <input
              id={`w-${key}`}
              type="range"
              min={0}
              max={100}
              value={parts[key]}
              onChange={(e) => { setParts({ ...parts, [key]: Number(e.target.value) }); }}
            />
          </div>
        ))}
        <span className="badge">Weights sum to {sum}% — normalized on save.</span>
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending || sum <= 0}
            onClick={() => {
              save(
                {
                  sort_batch_size: batch,
                  top_n: topN,
                  score_weights: {
                    engagement: parts.engagement / sum,
                    diversity: parts.diversity / sum,
                    relevance: parts.relevance / sum,
                    novelty: parts.novelty / sum,
                  },
                },
                "Sorting saved.",
              );
            }}
          >
            Save sorting
          </button>
        </div>
      </div>
    </section>
  );
}

function DataTab(): React.JSX.Element {
  const settings = useSettings();
  const { save, pending } = useSave();
  const view = settings.data?.settings ?? {};
  const num = (key: string, fallback: number): number => {
    const value = settingValue(view, key);
    return typeof value === "number" ? value : fallback;
  };
  const [retention, setRetention] = useState(num("retention_days", 30));
  const [mode, setMode] = useState(settingValue(view, "retention_mode") === "delete" ? "delete" : "archive");
  const [dedupe, setDedupe] = useState(num("dedupe_days", 3));

  return (
    <section className="card" aria-label="Data retention">
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="data-retention">Retention days</label>
          <input id="data-retention" className="input" type="number" min={1} style={{ width: 120 }} value={retention} onChange={(e) => { setRetention(Number(e.target.value)); }} />
        </div>
        <label>
          Retention mode{" "}
          <select className="select" aria-label="Retention mode" value={mode} onChange={(e) => { setMode(e.target.value); }}>
            <option value="archive">archive</option>
            <option value="delete">delete</option>
          </select>
        </label>
        <div className="form-field">
          <label htmlFor="data-dedupe">Dedupe days</label>
          <input id="data-dedupe" className="input" type="number" min={0} style={{ width: 120 }} value={dedupe} onChange={(e) => { setDedupe(Number(e.target.value)); }} />
        </div>
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={() => { save({ retention_days: retention, retention_mode: mode, dedupe_days: dedupe }, "Data settings saved."); }}
          >
            Save data settings
          </button>
        </div>
      </div>
    </section>
  );
}

function Appearance(): React.JSX.Element {
  const [theme, setTheme] = useTheme();
  return (
    <section className="card" aria-label="Appearance">
      <strong>Theme</strong>
      <div style={{ display: "flex", gap: 8 }}>
        {(["dark", "light"] as const).map((name) => (
          <button key={name} type="button" className="chip" aria-pressed={theme === name} onClick={() => { setTheme(name); }}>
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}

function Security(): React.JSX.Element {
  const settings = useSettings();
  const view = settings.data?.settings ?? {};
  const isSet = (key: string): boolean => {
    const entry: SettingView | undefined = view[key];
    return entry !== undefined && entry.is_set;
  };
  return (
    <section className="card" aria-label="Security">
      <strong>Secrets live in the environment, never in this UI.</strong>
      <p className="form-hint">Dashboard password is required when binding a non-localhost address.</p>
      <ul>
        {["dashboard_password", "omniroute_api_key", "jev_api_key", "google_service_account"].map((key) => (
          <li key={key}>
            <span className="mono">{key}</span>: {isSet(key) ? "set" : "not set"}
          </li>
        ))}
      </ul>
    </section>
  );
}
