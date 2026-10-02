/**
 * Cluster stage (Step-6 task 3): union-find over items. Trigram Jaccard ≥
 * 0.85 merges outright; pairs in 0.60–0.85 go to a Jev `same_story` noul
 * check (merge at ≥ 0.80). No checker (cut order, tight budget) → borderline
 * pairs stay split. Every item ends in exactly one cluster, deterministically.
 */
import { titleSimilarity } from "../pipeline/dedupe.js";

export const CLUSTER_MERGE_SIMILARITY = 0.85;
export const SAME_STORY_LOW = 0.6;
export const SAME_STORY_MERGE_SCORE = 0.8;

export interface ClusterInput {
  id: string;
  title: string;
  snippet: string;
}

export interface TopicCluster {
  id: string;
  itemIds: string[];
}

/** Borderline-pair oracle. Null = unknown/skip (budget gone, checker cut). */
export type SameStoryCheck = (a: { title: string; snippet: string }, b: { title: string; snippet: string }) => Promise<number | null>;

export function clusterItems(
  items: ClusterInput[],
  options: { sameStory?: SameStoryCheck | undefined } = {},
): Promise<TopicCluster[]> | TopicCluster[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id) ?? id;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const borderline: [ClusterInput, ClusterInput][] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (left === undefined || right === undefined) continue;
      const similarity = titleSimilarity(left.title, right.title);
      if (similarity >= CLUSTER_MERGE_SIMILARITY) union(left.id, right.id);
      else if (similarity >= SAME_STORY_LOW) borderline.push([left, right]);
    }
  }

  const finish = (): TopicCluster[] => {
    const groups = new Map<string, string[]>();
    for (const item of items) {
      const root = find(item.id);
      const group = groups.get(root) ?? [];
      group.push(item.id);
      groups.set(root, group);
    }
    // Deterministic ids: largest cluster first, then first-seen order.
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    return sorted.map((itemIds, index) => ({ id: `c${String(index)}`, itemIds: [...itemIds].sort() }));
  };

  if (options.sameStory === undefined || borderline.length === 0) return finish();
  const check = options.sameStory;
  return (async () => {
    for (const [left, right] of borderline) {
      if (find(left.id) === find(right.id)) continue;
      let score: number | null = null;
      try {
        score = await check({ title: left.title, snippet: left.snippet }, { title: right.title, snippet: right.snippet });
      } catch {
        score = null;
      }
      if (score !== null && score >= SAME_STORY_MERGE_SCORE) union(left.id, right.id);
    }
    return finish();
  })();
}

/** Production oracle: one Jev `same_story` noul per borderline pair. */
export function jevSameStory(
  classify: (state: Record<string, string>) => Promise<number | null>,
): SameStoryCheck {
  return async (a, b) => classify({ a: `${a.title} ${a.snippet}`, b: `${b.title} ${b.snippet}` });
}
