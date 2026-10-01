import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopicCard } from "./TopicCard.js";
import type { SortedTopic } from "../lib/api.js";

const TOPIC: SortedTopic = {
  topic_id: "t1",
  run_id: "run-1",
  run_date: "2026-09-30",
  rank: 1,
  title: "Test topic",
  summary: "Test summary.",
  category: "Tech",
  tags: ["ai", "llm"],
  trend_score: 92,
  score_engagement: 0.9,
  score_diversity: 0.5,
  score_relevance: 0.9,
  score_novelty: 0.8,
  momentum: "rising",
  sentiment: "positive",
  why_trending: "Coverage.",
  content_angles: ["Angle one", "Angle two", "Angle three"],
  evidence_item_ids: ["a1"],
  source_count: 2,
  top_urls: ["https://a.example.com/1"],
  jev_model: "stub",
  prompt_version: "v1",
  sorted_at: "2026-09-30T07:00:00.000Z",
  is_latest: true,
  hidden: false,
};

describe("TopicCard", () => {
  it("renders rank, score, momentum, chips and angles", () => {
    render(<TopicCard topic={TOPIC} selected={false} onOpen={() => undefined} />);
    expect(screen.getByText("Test topic")).toBeDefined();
    expect(screen.getByLabelText("Trend score 92 out of 100")).toBeDefined();
    expect(screen.getByLabelText("Momentum: rising")).toBeDefined();
    expect(screen.getByText("Tech")).toBeDefined();
    expect(screen.getByText("3 content angles")).toBeDefined();
  });

  it("opens on click and on Enter", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { rerender } = render(<TopicCard topic={TOPIC} selected={false} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: /Test topic/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(<TopicCard topic={TOPIC} selected={true} onOpen={onOpen} />);
    const card = screen.getByRole("button", { name: /Test topic/ });
    card.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
