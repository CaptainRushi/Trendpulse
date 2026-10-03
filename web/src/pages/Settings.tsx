import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import type { SettingView } from "../lib/api.js";
import { useSettings } from "../hooks/useApi.js";
import { useToast } from "../components/Toast.js";
import { ErrorState, SkeletonGrid } from "../components/States.js";
import { Pill, Step, Steps } from "../components/decode.js";

/**
 * Settings (docs/11 §4.4): Steps rows for sheets, omniroute, jev,
 * schedule, niches. Connection tests gate the saves below them —
 * nothing is saved until its connection proves itself.
 */
export function Settings(): React.JSX.Element {
  const settings = useSettings();
  const [passed, setPassed] = useState<Record<string, boolean>>({});
  const markSheets = useCallback((ok: boolean) => {
    setPassed((prev) => ({ ...prev, sheets: ok }));
  }, []);
  const markOmni = useCallback((ok: boolean) => {
    setPassed((prev) => ({ ...prev, omniroute: ok }));
  }, []);
  const markJev = useCallback((ok: boolean) => {
    setPassed((prev) => ({ ...prev, jev: ok }));
  }, []);

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
  const view = settings.data.settings;

  return (
    <div className="page">
      <section aria-label="Settings" style={{ marginTop: 32 }}>
        <p className="eyebrow">settings</p>
        <h1>connections first.</h1>
        <p className="reading">secrets live in .env and never leave the server — the ui only shows whether each one is set.</p>
      </section>
      <section aria-label="Setup steps">
        <Steps>
          <Step index={0} title="google sheets">
            <SecretState view={view} settingKey="google_service_account" label="service account" />
            <SecretState view={view} settingKey="sheet_id" label="sheet id" />
            <SheetsTest onResult={markSheets} />
          </Step>
          <Step index={1} title="omniroute">
            <SecretState view={view} settingKey="omniroute_api_key" label="api key" />
            <OmniTest onResult={markOmni} />
          </Step>
          <Step index={2} title="jev">
            <SecretState view={view} settingKey="jev_api_key" label="api key" />
            <JevTest onResult={markJev} />
          </Step>
          <Step index={3} title="schedule">
            <ScheduleRow canSave={passed["sheets"] === true} />
          </Step>
          <Step index={4} title="niches">
            <NichesRow canSave={passed["jev"] === true} />
          </Step>
        </Steps>
      </section>
    </div>
  );
}

function SecretState({ view, settingKey, label }: { view: Record<string, SettingView>; settingKey: string; label: string }): React.JSX.Element {
  const entry = view[settingKey];
  const isSet = entry?.is_set === true;
  return (
    <p>
      {label}:{" "}
      <Pill tone={isSet ? "good" : undefined}>
        {isSet ? "•••• set" : "not set"}
      </Pill>{" "}
      <span className="form-hint">replace it in .env, then restart.</span>
    </p>
  );
}

interface ProbeOk {
  ok: boolean;
  error?: string;
  models?: string[];
  model?: string;
  choice?: string;
  confidence?: number;
  latency_ms?: number;
  tabs?: string[];
  service_account_email?: string;
}

function useProbe(path: string): {
  run: (body: unknown) => void;
  result: ProbeOk | null;
  pending: boolean;
} {
  const toast = useToast();
  const [result, setResult] = useState<ProbeOk | null>(null);
  const [pending, setPending] = useState(false);
  return {
    result,
    pending,
    run: (body: unknown) => {
      setPending(true);
      api
        .post<ProbeOk>(path, body)
        .then((res) => {
          setResult(res);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setResult({ ok: false, error: message });
          toast({ tone: "bad", message });
        })
        .finally(() => {
          setPending(false);
        });
    },
  };
}

function ResultPill({ result }: { result: ProbeOk | null }): React.JSX.Element | null {
  if (!result) return null;
  if (!result.ok) return <Pill tone="bad">{result.error ?? "failed"}</Pill>;
  const detail = result.models
    ? result.models.slice(0, 3).join(", ")
    : result.choice !== undefined
      ? `${result.choice} ${(result.confidence ?? 0).toFixed(2)}`
      : result.service_account_email ?? result.model ?? "ok";
  return (
    <Pill tone="good">
      ok · {detail}
      {result.latency_ms !== undefined ? ` · ${String(result.latency_ms)}ms` : ""}
    </Pill>
  );
}

function SheetsTest({ onResult }: { onResult: (ok: boolean) => void }): React.JSX.Element {
  const probe = useProbe("/api/setup/test-sheets");
  const [sheetId, setSheetId] = useState("");
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="set-sheet-id">sheet id</label>
        <input id="set-sheet-id" className="input" value={sheetId} onChange={(e) => { setSheetId(e.target.value); }} placeholder="from the sheet url" />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ minHeight: 38 }}
          disabled={probe.pending}
          onClick={() => {
            probe.run({ sheet_id: sheetId || undefined });
          }}
        >
          test connection
        </button>
        <ResultPill result={probe.result} />
      </div>
      {probe.result ? (
        <ProbeWatcher result={probe.result} onResult={onResult} />
      ) : null}
    </div>
  );
}

function OmniTest({ onResult }: { onResult: (ok: boolean) => void }): React.JSX.Element {
  const probe = useProbe("/api/setup/test-omniroute");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="set-omni-url">base url</label>
        <input id="set-omni-url" className="input" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); }} placeholder="http://localhost:20128/v1" />
      </div>
      <div className="form-field">
        <label htmlFor="set-omni-key">api key</label>
        <input id="set-omni-key" className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); }} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ minHeight: 38 }}
          disabled={probe.pending}
          onClick={() => {
            probe.run({ base_url: baseUrl, api_key: apiKey || undefined });
          }}
        >
          test connection
        </button>
        <ResultPill result={probe.result} />
      </div>
      {probe.result ? <ProbeWatcher result={probe.result} onResult={onResult} /> : null}
    </div>
  );
}

function JevTest({ onResult }: { onResult: (ok: boolean) => void }): React.JSX.Element {
  const probe = useProbe("/api/setup/test-jev");
  const [model, setModel] = useState("");
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="set-jev-model">model</label>
        <input id="set-jev-model" className="input mono" value={model} onChange={(e) => { setModel(e.target.value); }} placeholder="jev-latest" />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ minHeight: 38 }}
          disabled={probe.pending}
          onClick={() => {
            probe.run({ model });
          }}
        >
          test connection
        </button>
        <ResultPill result={probe.result} />
      </div>
      {probe.result ? <ProbeWatcher result={probe.result} onResult={onResult} /> : null}
      <span className="form-hint">runs one sample classification with the configured endpoint and key.</span>
    </div>
  );
}

/** Reports each settled probe via effect (never setState during render). */
function ProbeWatcher({ result, onResult }: { result: ProbeOk; onResult: (ok: boolean) => void }): null {
  const ok = result.ok;
  useEffect(() => {
    onResult(ok);
  }, [ok, onResult]);
  return null;
}

function useSave(): { save: (values: Record<string, unknown>) => void; pending: boolean } {
  const toast = useToast();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  return {
    pending,
    save: (values) => {
      setPending(true);
      api
        .put("/api/settings", values)
        .then(() => {
          void client.invalidateQueries({ queryKey: ["settings"] });
          toast({ tone: "good", message: "saved." });
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

function ScheduleRow({ canSave }: { canSave: boolean }): React.JSX.Element {
  const settings = useSettings();
  const { save, pending } = useSave();
  const view = settings.data?.settings ?? {};
  const current = view["schedule_cron"]?.value;
  const [cron, setCron] = useState(typeof current === "string" ? current : "0 6 * * *");
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="set-cron">cron schedule</label>
        <input id="set-cron" className="input mono" value={cron} onChange={(e) => { setCron(e.target.value); }} />
        <span className="form-hint">hot-reloads the scheduler on save.</span>
      </div>
      <div>
        <button type="button" className="btn btn-ghost" disabled={pending || !canSave} onClick={() => { save({ schedule_cron: cron }); }}>
          save schedule
        </button>
        {!canSave ? <span className="form-hint"> pass the sheets test first.</span> : null}
      </div>
    </div>
  );
}

function NichesRow({ canSave }: { canSave: boolean }): React.JSX.Element {
  const settings = useSettings();
  const { save, pending } = useSave();
  const view = settings.data?.settings ?? {};
  const current = view["niches"]?.value;
  const initial = Array.isArray(current) ? current.filter((n): n is string => typeof n === "string").join(", ") : "";
  const [text, setText] = useState(initial);
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="set-niches">niches, comma-separated</label>
        <input id="set-niches" className="input" value={text} onChange={(e) => { setText(e.target.value); }} />
        <span className="form-hint">jev measures relevance against these.</span>
      </div>
      <div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending || !canSave}
          onClick={() => {
            save({ niches: text.split(",").map((s) => s.trim()).filter((s) => s.length > 0) });
          }}
        >
          save niches
        </button>
        {!canSave ? <span className="form-hint"> pass the jev test first.</span> : null}
      </div>
    </div>
  );
}
