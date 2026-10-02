/**
 * Aggregate stage (Step-6 task 4) + momentum rules (task 5), all in code.
 * Category/sentiment are confidence-weighted votes; R is mean niche_fit
 * (mean quality when niches are unset); N is mean novelty; E weights the
 * peak item 0.7 against the mean 0.3. Momentum never emits `fading`.
 */
import type { ItemLabels } from "@trendpulse/shared";
import type { TopicCluster } from "./clusterTopics.js";

export type Momentum = "new" | "rising" | "peak" | "steady";

export interface AggregatedCluster {
  clusterId: string;
  itemIds: string[];
  category: string;
  sentiment: string;
  relevance: number;
  novelty: number;
  engagement: number;
  meanNorm: number;
  sourceCount: number;
  momentum: Momentum;
}

function weightedVote(votes: { value: string; weight: number }[]): string {
  const totals = new Map<string, number>();
  for (const vote of votes) totals.set(vote.value, (totals.get(vote.value) ?? 0) + vote.weight);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "Other";
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Task-5 rules in order: all-new beats peak beats rising beats steady. */
export function computeMomentum(options: {
  sourceCount: number;
  meanNorm: number;
  allFirstSeenToday: boolean;
}): Momentum {
  if (options.allFirstSeenToday) return "new";
  if (options.sourceCount >= 3 && options.meanNorm >= 0.8) return "peak";
  if (options.sourceCount >= 2 && options.meanNorm >= 0.6) return "rising";
  return "steady";
}

export interface AggregateItem {
  id: string;
  source: string;
  engagementNorm: number;
  firstSeenToday: boolean;
  labels: ItemLabels;
}

export function aggregateClusters(
  clusters: TopicCluster[],
  itemsById: Map<string, AggregateItem>,
): AggregatedCluster[] {
  return clusters.map((cluster) => {
    const members = cluster.itemIds
      .map((id) => itemsById.get(id))
      .filter((item): item is AggregateItem => item !== undefined);
    const norms = members.map((m) => m.engagementNorm);
    const maxNorm = norms.length > 0 ? Math.max(...norms) : 0;
    const meanNorm = mean(norms);
    const sources = new Set(members.map((m) => m.source));
    return {
      clusterId: cluster.id,
      itemIds: cluster.itemIds,
      category: weightedVote(
        members.map((m) => ({ value: m.labels.category, weight: Math.max(m.labels.category_confidence, 0.01) })),
      ),
      sentiment: weightedVote(
        members.map((m) => ({ value: m.labels.sentiment, weight: Math.max(m.labels.category_confidence, 0.01) })),
      ),
      relevance: mean(members.map((m) => m.labels.niche_fit ?? m.labels.quality)),
      novelty: mean(members.map((m) => m.labels.novelty)),
      engagement: maxNorm * 0.7 + meanNorm * 0.3,
      meanNorm,
      sourceCount: sources.size,
      momentum: computeMomentum({
        sourceCount: sources.size,
        meanNorm,
        allFirstSeenToday: members.length > 0 && members.every((m) => m.firstSeenToday),
      }),
    };
  });
}
