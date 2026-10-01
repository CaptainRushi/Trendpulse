import type React from "react";
import { useEffect, useRef } from "react";
import { ExternalLink, X } from "lucide-react";
import type { RawItem, SortedTopic } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { formatDateTime } from "../lib/format";
import { CategoryChip, MomentumBadge } from "./badges";
import { ScoreRing } from "./ScoreRing";
import { AnglesList } from "./TopicCard";

/**
 * Topic drawer (§5.2): header → why → summary → score breakdown →
 * angles → evidence → footer. Focus-trapped dialog, Esc closes.
 */
export function TopicDrawer({
  topic,
  evidence,
  evidenceLoading,
  onClose,
}: {
  topic: SortedTopic;
  evidence: RawItem[];
  evidenceLoading: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const markdown = [
    `# ${topic.title} (${String(topic.trend_score)})`,
    "",
    topic.summary,
    "",
    `Why trending: ${topic.why_trending}`,
    "",
    "Angles:",
    ...topic.content_angles.map((a) => `- ${a}`),
    "",
    "Sources:",
    ...topic.top_urls.map((u) => `- ${u}`),
  ].join("\n");

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <section
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={topic.title}
        tabIndex={-1}
      >
        <div className="topic-card-head">
          <ScoreRing score={topic.trend_score} size={56} />
          <div>
            <h2 style={{ margin: 0 }}>{topic.title}</h2>
            <div className="topic-card-meta">
              <MomentumBadge momentum={topic.momentum} />
              <CategoryChip category={topic.category} />
              <span className="badge">{topic.sentiment}</span>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close topic details">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <section aria-label="Why it is trending">
          <h3>Why it&apos;s trending</h3>
          <p>{topic.why_trending}</p>
          <p>{topic.summary}</p>
        </section>

        <section aria-label="Score breakdown">
          <h3>Score breakdown</h3>
          <ScoreBreakdown
            parts={[
              ["Engagement", topic.score_engagement, 0.35],
              ["Source diversity", topic.score_diversity, 0.25],
              ["Relevance", topic.score_relevance, 0.25],
              ["Novelty", topic.score_novelty, 0.15],
            ]}
          />
        </section>

        <section aria-label="Content angles">
          <h3>Content angles</h3>
          <AnglesList angles={topic.content_angles} topicId={topic.topic_id} />
        </section>

        <section aria-label="Evidence">
          <h3>Evidence ({evidence.length})</h3>
          {evidenceLoading ? (
            <p>Loading evidence…</p>
          ) : (
            <ul>
              {evidence.map((item) => (
                <li key={item.id}>
                  <span className="badge">{item.source}</span>{" "}
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.title} <ExternalLink size={12} aria-hidden="true" />
                  </a>{" "}
                  <span className="badge">
                    {item.engagement_score ?? "—"} · {formatDateTime(item.published_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              copyToClipboard(markdown);
            }}
          >
            Copy as Markdown
          </button>
        </footer>
      </section>
    </>
  );
}

function ScoreBreakdown({ parts }: { parts: [string, number, number][] }): React.JSX.Element {
  return (
    <div>
      {parts.map(([label, value, weight]) => (
        <div key={label} className="score-bar">
          <span>
            {label} <span className="badge">×{weight.toFixed(2)}</span>
          </span>
          <div
            className="score-bar-track"
            role="img"
            aria-label={`${label}: ${String(Math.round(value * 100))} percent`}
          >
            <div className="score-bar-fill" style={{ width: `${String(Math.round(value * 100))}%` }} />
          </div>
          <span className="mono">{value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
