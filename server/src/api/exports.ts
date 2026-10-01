/**
 * CSV + Markdown exports (same filters as /trends, same loader — no
 * duplicated filter logic). Attachment disposition so direct navigation
 * downloads; XHR clients ignore it and read the body.
 */
import type { FastifyInstance } from "fastify";
import type { SortedTrendRecord } from "../sheets/schema.js";
import type { AppContext } from "./context.js";
import { loadTrends, parseTrendsQuery } from "./trends.js";

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function topicsToCsv(topics: SortedTrendRecord[], date: string): string {
  const header = [
    "rank",
    "title",
    "summary",
    "category",
    "tags",
    "trend_score",
    "momentum",
    "sentiment",
    "why_trending",
    "top_urls",
    "evidence_item_ids",
  ];
  const lines = topics.map((topic) =>
    [
      String(topic.rank),
      topic.title,
      topic.summary,
      topic.category,
      JSON.stringify(topic.tags),
      String(topic.trend_score),
      topic.momentum,
      topic.sentiment,
      topic.why_trending,
      JSON.stringify(topic.top_urls),
      JSON.stringify(topic.evidence_item_ids),
    ]
      .map(csvCell)
      .join(","),
  );
  return `# date: ${date}\n${header.join(",")}\n${lines.join("\n")}\n`;
}

export function topicsToMarkdown(topics: SortedTrendRecord[], date: string): string {
  const parts = [`# Trends for ${date}`, ""];
  for (const topic of topics) {
    parts.push(`## ${String(topic.rank)}. ${topic.title} (${String(topic.trend_score)})`, "");
    parts.push(topic.summary, "");
    parts.push(`- Category: ${topic.category} | Momentum: ${topic.momentum} | Sentiment: ${topic.sentiment}`);
    parts.push(`- Why trending: ${topic.why_trending}`);
    parts.push(`- Angles: ${topic.content_angles.join(" / ")}`);
    if (topic.top_urls.length > 0) {
      parts.push("- Links:");
      for (const url of topic.top_urls) parts.push(`  - ${url}`);
    }
    parts.push("");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

export function registerExports(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/export/topics.csv", async (request, reply) => {
    const filter = parseTrendsQuery(ctx, request.query);
    const result = await loadTrends(ctx, filter);
    const body = topicsToCsv(result.items, result.date);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="topics-${result.date}.csv"`)
      .send(body);
  });

  app.get("/api/export/topics.md", async (request, reply) => {
    const filter = parseTrendsQuery(ctx, request.query);
    const result = await loadTrends(ctx, filter);
    const body = topicsToMarkdown(result.items, result.date);
    reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="topics-${result.date}.md"`)
      .send(body);
  });
}
