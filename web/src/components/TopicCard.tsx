import type React from "react";
import { Copy } from "lucide-react";
import type { SortedTopic } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { CategoryChip, MomentumBadge } from "./badges";
import { ScoreRing } from "./ScoreRing";

/** Topic card (§5.1): rank, ring, momentum, title, summary, chips, angles. */
export function TopicCard({
  topic,
  selected,
  onOpen,
}: {
  topic: SortedTopic;
  selected: boolean;
  onOpen: (topic: SortedTopic) => void;
}): React.JSX.Element {
  return (
    <article
      className="topic-card"
      data-selected={selected || undefined}
      onClick={(event) => {
        // Nested controls (title button, copy buttons, angles) handle their
        // own clicks — the card itself opens only for bare-surface clicks.
        const target = event.target as HTMLElement | null;
        if (target && target.closest("button, a, summary, select, input")) return;
        onOpen(topic);
      }}
    >
      <div className="topic-card-head">
        <strong aria-label={`Rank ${String(topic.rank)}`}>{topic.rank}</strong>
        <ScoreRing score={topic.trend_score} />
        <MomentumBadge momentum={topic.momentum} />
      </div>
      <h3>
        <button
          type="button"
          className="title-button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(topic);
          }}
          aria-label={`${topic.title} (score ${String(topic.trend_score)}, open details)`}
        >
          {topic.title}
        </button>
      </h3>
      <p>{topic.summary}</p>
      <div className="topic-card-meta">
        <CategoryChip category={topic.category} />
        {topic.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="chip" aria-hidden="true">
            #{tag}
          </span>
        ))}
        <span className="badge" title={topic.top_urls.join("\n")}>
          {topic.source_count} {topic.source_count === 1 ? "source" : "sources"}
        </span>
      </div>
      <details
        onClick={(event) => { event.stopPropagation(); }}
        onKeyDown={(event) => { event.stopPropagation(); }}
      >
        <summary>{topic.content_angles.length} content angles</summary>
        <AnglesList angles={topic.content_angles} topicId={topic.topic_id} />
      </details>
    </article>
  );
}

export function AnglesList({ angles, topicId }: { angles: string[]; topicId: string }): React.JSX.Element {
  const copyAll = (): void => {
    copyToClipboard(angles.map((a, i) => `${String(i + 1)}. ${a}`).join("\n"));
  };
  return (
    <div>
      <ul>
        {angles.map((angle, index) => (
          <AngleRow key={`${topicId}-${String(index)}`} angle={angle} index={index} />
        ))}
      </ul>
      <button type="button" className="btn btn-ghost" onClick={copyAll}>
        Copy all
      </button>
    </div>
  );
}

function AngleRow({ angle, index }: { angle: string; index: number }): React.JSX.Element {
  return (
    <li>
      {angle}{" "}
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={`Copy angle ${String(index + 1)}`}
        onClick={() => {
          copyToClipboard(angle);
        }}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
