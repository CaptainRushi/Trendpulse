import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useSources } from "../hooks/useApi.js";
import { useToast } from "../components/Toast.js";
import {
  clearWizardState,
  defaultWizardState,
  loadWizardState,
  saveWizardState,
  stepCanContinue,
  WIZARD_STEPS,
} from "../wizard/logic.js";
import type { WizardState } from "../wizard/logic.js";

/**
 * Setup wizard (§5.8): full-screen stepper, progress in localStorage,
 * each step blocks Next until its probe passes. Finish persists
 * non-secrets (sheet id, urls, models, sources, niches, schedule),
 * marks setup complete, and fires the first collection.
 */
export function Wizard(): React.JSX.Element {
  const [state, setState] = useState<WizardState>(() => {
    try {
      return loadWizardState(window.localStorage);
    } catch {
      return defaultWizardState();
    }
  });
  const [probeMessage, setProbeMessage] = useState("");
  const [probing, setProbing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const sources = useSources();

  useEffect(() => {
    try {
      saveWizardState(window.localStorage, state);
    } catch {
      // Ignore persistence failures.
    }
  }, [state]);

  const step = WIZARD_STEPS[state.step] ?? "welcome";
  const patch = (next: Partial<WizardState>): void => {
    setState((s) => ({ ...s, ...next }));
  };
  const canContinue = stepCanContinue(state);

  const probe = (which: "sheets" | "omniroute" | "jev"): void => {
    setProbing(true);
    setProbeMessage("Testing…");
    const calls = {
      sheets: () =>
        api.post<{ ok: boolean; error?: string }>("/api/setup/test-sheets", {
          ...(state.sheets.sheet_id ? { sheet_id: state.sheets.sheet_id } : {}),
          ...(state.sheets.service_account_json
            ? { service_account_json: state.sheets.service_account_json }
            : {}),
        }),
      omniroute: () =>
        api.post<{ ok: boolean; error?: string }>("/api/setup/test-omniroute", {
          base_url: state.omniroute.base_url,
          ...(state.omniroute.api_key ? { api_key: state.omniroute.api_key } : {}),
        }),
      jev: () =>
        api.post<{ ok: boolean; error?: string }>("/api/setup/test-jev", {
          ...(state.jev.base_url ? { base_url: state.jev.base_url } : {}),
          ...(state.jev.api_key ? { api_key: state.jev.api_key } : {}),
          model: state.jev.model,
        }),
    } as const;
    calls[which]()
      .then((result) => {
        const ok = result.ok;
        setProbeMessage(ok ? "Connection works." : (result.error ?? "Connection failed."));
        setState((s) => ({ ...s, tested: { ...s.tested, [which]: ok } }));
        toast({ tone: ok ? "good" : "bad", message: ok ? "Connection works." : (result.error ?? "Connection failed.") });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setProbeMessage(message);
        toast({ tone: "bad", message });
      })
      .finally(() => {
        setProbing(false);
      });
  };

  const finish = (): void => {
    setFinishing(true);
    const enabled = new Set(state.sources.enabled);
    const sourceUpdates = (sources.data ?? []).map((source) =>
      api.put(`/api/sources/${source.key}`, { enabled: enabled.has(source.key) }).catch(() => undefined),
    );
    Promise.all(sourceUpdates)
      .then(() =>
        api.put("/api/settings", {
          ...(state.sheets.sheet_id ? { sheet_id: state.sheets.sheet_id } : {}),
          ...(state.omniroute.base_url ? { omniroute_base_url: state.omniroute.base_url } : {}),
          ...(state.jev.base_url ? { jev_base_url: state.jev.base_url } : {}),
          ...(state.jev.model ? { jev_model: state.jev.model } : {}),
          niches: state.sources.niches.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
          schedule_cron: state.sources.cron,
          setup_complete: true,
        }),
      )
      .then(() => api.post<{ run_id: string }>("/api/runs", {}))
      .then((run) => {
        try {
          clearWizardState(window.localStorage);
        } catch {
          // Ignore.
        }
        toast({ tone: "good", message: "Setup complete — first collection started." });
        void navigate(`/runs/${run.run_id}`);
      })
      .catch((error: unknown) => {
        toast({ tone: "bad", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setFinishing(false);
      });
  };

  const stepIndex = useMemo(() => WIZARD_STEPS.indexOf(step), [step]);

  return (
    <div className="wizard">
      <h1>Set up TrendPulse</h1>
      <ol className="wizard-steps" aria-label="Setup progress">
        {WIZARD_STEPS.map((name, index) => (
          <li key={name} data-done={index <= stepIndex} aria-label={`Step ${String(index + 1)}: ${name}`} />
        ))}
      </ol>

      {step === "welcome" ? (
        <section className="card" aria-label="Welcome">
          <h2>Welcome</h2>
          <p>TrendPulse collects trending topics daily, has Jev rank them, and shows both on a dashboard.</p>
          <ul>
            <li>A Google Sheet (raw + ranked tabs) shared with a service account.</li>
            <li>OmniRoute (or any OpenAI-compatible gateway) for page extraction.</li>
            <li>Jev (direct or through OmniRoute) for clustering and scoring.</li>
          </ul>
          <p className="form-hint">Keys stay in your environment — the wizard tests them, never stores them.</p>
        </section>
      ) : null}

      {step === "sheets" ? (
        <section className="card" aria-label="Google Sheets">
          <h2>Google Sheets</h2>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="wiz-sheet-id">Sheet ID (from the sheet URL)</label>
              <input
                id="wiz-sheet-id"
                className="input"
                value={state.sheets.sheet_id}
                onChange={(e) => { patch({ sheets: { ...state.sheets, sheet_id: e.target.value } }); }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="wiz-sa">Service account JSON</label>
              <textarea
                id="wiz-sa"
                className="input"
                rows={4}
                value={state.sheets.service_account_json}
                onChange={(e) => { patch({ sheets: { ...state.sheets, service_account_json: e.target.value } }); }}
                placeholder='Paste the key file contents (or leave empty to use ./secrets/service-account.json)'
              />
              <span className="form-hint">Share the sheet with the service-account email as Editor.</span>
            </div>
            <div>
              <button type="button" className="btn btn-ghost" disabled={probing} onClick={() => { probe("sheets"); }}>
                Test &amp; create tabs
              </button>
            </div>
            <div className="badge" role="status">{probeMessage || "Not tested yet."}</div>
          </div>
        </section>
      ) : null}

      {step === "omniroute" ? (
        <section className="card" aria-label="OmniRoute">
          <h2>OmniRoute</h2>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="wiz-omni-url">Base URL</label>
              <input
                id="wiz-omni-url"
                className="input"
                value={state.omniroute.base_url}
                onChange={(e) => { patch({ omniroute: { ...state.omniroute, base_url: e.target.value } }); }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="wiz-omni-key">API key (env <span className="mono">OMNIROUTE_API_KEY</span>)</label>
              <input
                id="wiz-omni-key"
                className="input"
                type="password"
                autoComplete="off"
                value={state.omniroute.api_key}
                onChange={(e) => { patch({ omniroute: { ...state.omniroute, api_key: e.target.value } }); }}
              />
            </div>
            <div>
              <button type="button" className="btn btn-ghost" disabled={probing} onClick={() => { probe("omniroute"); }}>
                Test
              </button>
            </div>
            <div className="badge" role="status">{probeMessage || "Not tested yet."}</div>
          </div>
        </section>
      ) : null}

      {step === "jev" ? (
        <section className="card" aria-label="Jev">
          <h2>Jev</h2>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="wiz-jev-url">Base URL (empty = ride OmniRoute)</label>
              <input
                id="wiz-jev-url"
                className="input"
                value={state.jev.base_url}
                onChange={(e) => { patch({ jev: { ...state.jev, base_url: e.target.value } }); }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="wiz-jev-model">Model</label>
              <input
                id="wiz-jev-model"
                className="input"
                value={state.jev.model}
                onChange={(e) => { patch({ jev: { ...state.jev, model: e.target.value } }); }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="wiz-jev-key">API key (env <span className="mono">JEV_API_KEY</span>)</label>
              <input
                id="wiz-jev-key"
                className="input"
                type="password"
                autoComplete="off"
                value={state.jev.api_key}
                onChange={(e) => { patch({ jev: { ...state.jev, api_key: e.target.value } }); }}
              />
            </div>
            <div>
              <button type="button" className="btn btn-ghost" disabled={probing || state.jev.model.trim() === ""} onClick={() => { probe("jev"); }}>
                Test with sample
              </button>
            </div>
            <div className="badge" role="status">{probeMessage || "Not tested yet."}</div>
          </div>
        </section>
      ) : null}

      {step === "sources" ? (
        <section className="card" aria-label="Sources and schedule">
          <h2>Sources &amp; schedule</h2>
          <fieldset>
            <legend>Sources to collect</legend>
            {(sources.data ?? []).map((source) => (
              <label key={source.key} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
                <input
                  type="checkbox"
                  checked={state.sources.enabled.includes(source.key)}
                  onChange={(e) => {
                    const enabled = e.target.checked
                      ? [...state.sources.enabled, source.key]
                      : state.sources.enabled.filter((k) => k !== source.key);
                    patch({ sources: { ...state.sources, enabled } });
                  }}
                />
                {source.label}
              </label>
            ))}
          </fieldset>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="wiz-niches">Niches (comma-separated)</label>
              <input
                id="wiz-niches"
                className="input"
                value={state.sources.niches}
                onChange={(e) => { patch({ sources: { ...state.sources, niches: e.target.value } }); }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="wiz-cron">Daily schedule (cron)</label>
              <input
                id="wiz-cron"
                className="input mono"
                value={state.sources.cron}
                onChange={(e) => { patch({ sources: { ...state.sources, cron: e.target.value } }); }}
              />
            </div>
          </div>
        </section>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={state.step === 0}
          onClick={() => {
            setProbeMessage("");
            patch({ step: Math.max(0, state.step - 1) });
          }}
        >
          Back
        </button>
        <span style={{ flex: 1 }} />
        {step === "sources" ? (
          <button type="button" className="btn btn-primary" disabled={!canContinue || finishing} onClick={finish}>
            {finishing ? "Starting…" : "Finish & run first collection"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => {
              setProbeMessage("");
              patch({ step: Math.min(WIZARD_STEPS.length - 1, state.step + 1) });
            }}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
