import type React from "react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api.js";
import type { SourceEntry } from "../lib/api.js";
import { useSettings, useSources } from "../hooks/useApi.js";
import { useToast } from "../components/Toast.js";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States.js";
import { StatusPill } from "../components/badges.js";

/**
 * Sources (§5.5): per-source cards (toggle, health, last run, requires,
 * limit) + custom RSS/page lists + niche keywords.
 */
export function Sources(): React.JSX.Element {
  const sources = useSources();
  const toast = useToast();

  if (sources.isPending) return <div className="page"><SkeletonGrid count={3} /></div>;
  if (sources.isError) return <div className="page"><ErrorState error={sources.error} /></div>;
  return (
    <div className="page">
      <h1 style={{ margin: 0 }}>Sources</h1>
      {sources.data.map((source) => (
        <SourceCard
          key={source.key}
          source={source}
          onChanged={() => {
            toast({ tone: "good", message: `${source.label} updated.` });
          }}
          onError={(error) => {
            toast({ tone: "bad", message: error.message });
          }}
        />
      ))}
      <CustomLists onToast={(tone, message) => {
        toast({ tone, message });
      }} />
      <Niches onToast={(tone, message) => {
        toast({ tone, message });
      }} />
    </div>
  );
}

function SourceCard({
  source,
  onChanged,
  onError,
}: {
  source: SourceEntry;
  onChanged: () => void;
  onError: (error: Error) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [limit, setLimit] = useState(source.item_limit);
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`/api/sources/${source.key}`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["sources"] });
      onChanged();
    },
    onError,
  });

  const health = !source.enabled ? "off" : source.last_status === "ok" ? "ok" : source.last_status === "error" ? "error" : "warn";
  return (
    <section className="card" aria-label={source.label}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{source.label}</strong>
        <StatusPill status={health} />
        <span style={{ flex: 1 }} />
        <label>
          <input
            type="checkbox"
            checked={source.enabled}
            disabled={mutate.isPending}
            onChange={(event) => { mutate.mutate({ enabled: event.target.checked }); }}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="topic-card-meta" style={{ marginTop: 8 }}>
        <span className="badge">
          last run: {source.last_items ?? "—"} items{source.last_run_at ? ` · ${source.last_run_at.slice(0, 16).replace("T", " ")}` : ""}
        </span>
        {source.last_error ? <span className="badge">error: {source.last_error}</span> : null}
      </div>
      {source.requires.length > 0 ? (
        <div className="topic-card-meta" style={{ marginTop: 4 }}>
          <span className="badge">Needs:</span>
          {source.requires.map((req) => (
            <span key={req} className="chip">{req}</span>
          ))}
        </div>
      ) : null}
      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <label>
          Item limit{" "}
          <input
            className="input"
            type="number"
            min={1}
            style={{ width: 90 }}
            aria-label={`${source.label} item limit`}
            value={limit}
            onChange={(event) => { setLimit(Number(event.target.value)); }}
          />
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={mutate.isPending || limit === source.item_limit}
          onClick={() => { mutate.mutate({ item_limit: limit }); }}
        >
          Save
        </button>
      </div>
    </section>
  );
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function CustomLists({ onToast }: { onToast: (tone: "good" | "bad", message: string) => void }): React.JSX.Element {
  const sources = useSources();
  const client = useQueryClient();
  const [draft, setDraft] = useState({ rss: "", webpage: "" });

  const rss = sources.data?.find((s) => s.key === "rss");
  const webpage = sources.data?.find((s) => s.key === "webpage");

  const save = (key: string, field: string, list: string[]): void => {
    const entry = sources.data?.find((s) => s.key === key);
    const config = { ...(entry?.config ?? {}) };
    config[field] = list;
    api
      .put(`/api/sources/${key}`, { config })
      .then(() => {
        void client.invalidateQueries({ queryKey: ["sources"] });
        onToast("good", "List updated — applies to the next run.");
      })
      .catch((error: unknown) => {
        onToast("bad", error instanceof Error ? error.message : String(error));
      });
  };

  const editor = (key: string, field: string, title: string, placeholder: string): React.JSX.Element => {
    const entry = sources.data?.find((s) => s.key === key);
    const list = entry ? stringList(entry.config[field]) : [];
    const value = key === "rss" ? draft.rss : draft.webpage;
    return (
      <section className="card" aria-label={title}>
        <strong>{title}</strong>
        <ul>
          {list.map((url) => (
            <li key={url} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="mono" style={{ overflowWrap: "anywhere" }}>{url}</span>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Remove ${url}`}
                onClick={() => { save(key, field, list.filter((u) => u !== url)); }}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={placeholder}
            aria-label={`Add to ${title}`}
            value={value}
            onChange={(event) => { setDraft((d) => ({ ...d, [key]: event.target.value })); }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={value.trim() === ""}
            onClick={() => {
              save(key, field, [...list, value.trim()]);
              setDraft((d) => ({ ...d, [key]: "" }));
            }}
          >
            <Plus size={16} aria-hidden="true" /> Add
          </button>
        </div>
      </section>
    );
  };

  if (!rss || !webpage) return <EmptyState title="Source lists unavailable" />;
  return (
    <>
      {editor("rss", "feeds", "RSS feeds", "https://example.com/feed.xml")}
      {editor("webpage", "pages", "Watched pages", "https://example.com/article")}
    </>
  );
}

function Niches({ onToast }: { onToast: (tone: "good" | "bad", message: string) => void }): React.JSX.Element {
  const settings = useSettings();
  const client = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const current = settings.data?.settings["niches"]?.value;
  const niches: string[] = Array.isArray(current) ? current.filter((n): n is string => typeof n === "string") : [];
  const text = value ?? niches.join(", ");

  return (
    <section className="card" aria-label="Niche keywords">
      <strong>Niche keywords</strong>
      <p className="form-hint">Comma-separated. Jev measures relevance against these.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          aria-label="Niche keywords"
          value={text}
          onChange={(event) => { setValue(event.target.value); }}
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const list = text.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
            api
              .put("/api/settings", { niches: list })
              .then(() => {
                void client.invalidateQueries({ queryKey: ["settings"] });
                setValue(null);
                onToast("good", "Niches saved.");
              })
              .catch((error: unknown) => {
                onToast("bad", error instanceof Error ? error.message : String(error));
              });
          }}
        >
          Save
        </button>
      </div>
    </section>
  );
}
