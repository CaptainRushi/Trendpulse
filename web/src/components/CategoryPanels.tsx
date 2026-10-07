/**
 * Category panels (Doc 19 Q5): one panel per selected category with up to
 * TOP_PER_CATEGORY rows, each refreshable on its own. Plus the onboarding
 * card shown when my_categories is empty.
 */
import { useState } from "react";
import type React from "react";
import { Eyebrow, Panel, Pill } from "./decode";
import type { CategoryPanelData, PanelStatus } from "../lib/api";
import { ALL_CATEGORY_SLUGS } from "./MyCategories";

function statusTone(status: PanelStatus): "good" | "warn" | "bad" | "info" | undefined {
  if (status === "ok") return "good";
  if (status === "partial") return "warn";
  if (status === "failed") return "bad";
  if (status === "running") return "info";
  return undefined;
}

export function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function CategoryPanel({
  panel,
  running,
  onRefresh,
  onOpen,
}: {
  panel: CategoryPanelData;
  running: boolean;
  onRefresh: (slug: string) => void;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const sourcesOk = panel.sources.filter((s) => s.status === "ok").length;
  const hint = panel.sources.map((s) => `${s.name}: ${s.status}${s.hint ? ` (${s.hint})` : ""}`).join("\n");
  return (
    <Panel label={`${panel.category} trends`}>
      <div className="cat-panel-head">
        <Pill>{panel.category}</Pill>
        <Pill tone={statusTone(panel.status)}>{panel.status.replace("_", " ")}</Pill>
        <span className="form-hint">updated {fmtClock(panel.last_run_at)}</span>
        <span className="form-hint" title={hint}>
          {sourcesOk}/{panel.sources.length} sources
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={running}
          onClick={() => { onRefresh(panel.category); }}
        >
          refresh {panel.category}
        </button>
      </div>
      {panel.topics.map((topic) => (
        <button
          key={topic.id}
          type="button"
          className="topic-row"
          onClick={() => { onOpen(topic.id); }}
          aria-label={`Open ${topic.title}`}
        >
          <span className="topic-rank num">{topic.rank}</span>
          <span>
            <span className="topic-title">{topic.title}</span>
            <br />
            <span className="topic-summary">{topic.summary}</span>
            <span className="topic-meta">
              <Pill>{topic.momentum}</Pill>
              <span className="form-hint">{topic.source_count} {topic.source_count === 1 ? "source" : "sources"}</span>
            </span>
          </span>
          <span className="topic-score num" aria-label={`Trend score ${String(topic.score)}`}>
            {topic.score}
          </span>
        </button>
      ))}
      {panel.note ? <p className="form-hint" role="note">{panel.note}</p> : null}
    </Panel>
  );
}

export function CategoryPanels({
  panels,
  running,
  onRefresh,
  onOpen,
}: {
  panels: CategoryPanelData[];
  running: boolean;
  onRefresh: (slug: string) => void;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="cat-panels">
      {panels.map((panel) => (
        <CategoryPanel key={panel.category} panel={panel} running={running} onRefresh={onRefresh} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function OnboardingCard({
  max,
  saving,
  onSave,
}: {
  max: number;
  saving: boolean;
  onSave: (next: string[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string[]>([]);
  const toggle = (slug: string): void => {
    if (draft.includes(slug)) setDraft(draft.filter((s) => s !== slug));
    else if (draft.length < max) setDraft([...draft, slug]);
  };
  return (
    <Panel label="pick your categories">
      <Eyebrow>my categories</Eyebrow>
      <h2>pick your categories</h2>
      <p>today shows the top 5 topics for each category you pick — and only those get scraped and sorted.</p>
      <div className="chip-row" role="group" aria-label="available categories">
        {ALL_CATEGORY_SLUGS.map((slug) => (
          <button
            key={slug}
            type="button"
            className="chip"
            data-active={draft.includes(slug) || undefined}
            aria-pressed={draft.includes(slug)}
            onClick={() => { toggle(slug); }}
          >
            {slug}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={draft.length === 0 || saving}
        onClick={() => { onSave(draft); }}
      >
        {saving ? "saving…" : `save ${draft.length > 0 ? `${String(draft.length)} ` : ""}categor${draft.length === 1 ? "y" : "ies"}`}
      </button>
    </Panel>
  );
}
