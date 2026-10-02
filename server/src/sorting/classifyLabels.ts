/**
 * Classify stage (Step-6 task 1): ONE Jev request per pending item over the
 * q1 question set, LabelCache first, run budget honored, fallback classifier
 * on Jev failure. Answers map to shared ItemLabels; out-of-enum choices
 * land on a safe default with the coercion flag preserved.
 */
import type { StateDb } from "../db/sqlite.js";
import { JevBudgetExceeded, JevHttpError, JevTimeoutError, JevValidationError } from "../llm/jev.js";
import type { Classifier, ClassifyResult } from "../llm/classifier.js";
import type { JevAnswers } from "../llm/jev.js";
import { readCachedLabels, writeCachedLabels } from "../llm/labelCache.js";
import { ItemLabels } from "@trendpulse/shared";
import { QUESTION_SET_VERSION, buildQuestions } from "./questions.js";

export interface ClassifiableItem {
  id: string;
  contentHash: string;
  title: string;
  snippet: string;
  source: string;
  publishedAt: string | null;
}

export interface ItemLabelRecord {
  itemId: string;
  labels: ItemLabels;
}

export interface ClassifyStats {
  classified: number;
  cached: number;
  fallbackUsed: number;
  failed: string[];
  /** Budget ran out: remaining items unattempted, run goes partial. */
  budgetStopped: boolean;
}

const VALID_SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const;

/** JevAnswers → ItemLabels. "none" is a Jev verdict, not a display value. */
export function toItemLabels(answers: JevAnswers, classifier: "jev" | "fallback", nicheAsked: boolean): ItemLabels {
  const flags = Object.values(answers).flatMap((a) => a.flags);
  const categoryRaw = answers["category"];
  const categoryChoice = categoryRaw?.kind === "choice" ? categoryRaw.choice : "none";
  const sentimentRaw = answers["sentiment"];
  const sentimentChoice = sentimentRaw?.kind === "choice" ? sentimentRaw.choice : "none";
  const quality = answers["quality"];
  const niche = answers["niche_fit"];
  const novelty = answers["novelty"];
  return ItemLabels.parse({
    category: categoryChoice === "none" ? "Other" : categoryChoice,
    category_confidence: categoryRaw?.kind === "choice" ? categoryRaw.confidence : 0,
    quality: quality?.kind === "noul" ? quality.noul : 0,
    niche_fit: nicheAsked ? (niche?.kind === "noul" ? niche.noul : 0) : null,
    novelty: novelty?.kind === "noul" ? novelty.noul : 0,
    sentiment: (VALID_SENTIMENTS as readonly string[]).includes(sentimentChoice) ? sentimentChoice : "neutral",
    classifier,
    flags,
  });
}

export interface ClassifyDeps {
  db: StateDb;
  classifier: Classifier;
  fallback?: Classifier | undefined;
  fallbackEnabled: boolean;
  model: string;
  niches: string[];
}

export async function classifyItems(
  deps: ClassifyDeps,
  items: ClassifiableItem[],
): Promise<{ labeled: ItemLabelRecord[]; stats: ClassifyStats }> {
  const questions = buildQuestions(deps.niches);
  const nicheAsked = deps.niches.length > 0;
  const labeled: ItemLabelRecord[] = [];
  const stats: ClassifyStats = { classified: 0, cached: 0, fallbackUsed: 0, failed: [], budgetStopped: false };

  for (const item of items) {
    const cached = readCachedLabels(deps.db, item.id, QUESTION_SET_VERSION, deps.model);
    if (cached.length > 0) {
      const answers: JevAnswers = {};
      for (const row of cached) {
        const parsed = JSON.parse(row.answerJson) as { kind: string; choice?: string; confidence?: number; noul?: number };
        answers[row.question] =
          parsed.kind === "noul"
            ? { kind: "noul", noul: typeof parsed.noul === "number" ? parsed.noul : 0, flags: [] }
            : {
                kind: "choice",
                choice: typeof parsed.choice === "string" ? parsed.choice : "none",
                confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
                flags: [],
              };
      }
      labeled.push({
        itemId: item.id,
        labels: toItemLabels(answers, cached[0]?.classifier === "fallback" ? "fallback" : "jev", nicheAsked),
      });
      stats.cached += 1;
      continue;
    }
    let result: ClassifyResult;
    try {
      result = await deps.classifier.classify(
        { title: item.title, snippet: item.snippet, source: item.source, published_at: item.publishedAt ?? "" },
        questions,
      );
    } catch (error) {
      if (error instanceof JevBudgetExceeded) {
        stats.budgetStopped = true;
        break;
      }
      // Jev-family failures route to fallback/failed; anything else is a
      // bug or a kill — propagate with the stage left `running` (resume path).
      if (
        !(error instanceof JevTimeoutError || error instanceof JevHttpError || error instanceof JevValidationError)
      ) {
        throw error;
      }
      if (deps.fallback === undefined || !deps.fallbackEnabled) {
        stats.failed.push(item.id);
        continue;
      }
      try {
        result = await deps.fallback.classify(
          { title: item.title, snippet: item.snippet, source: item.source, published_at: item.publishedAt ?? "" },
          questions,
        );
      } catch {
        stats.failed.push(item.id);
        continue;
      }
    }
    stats.classified += 1;
    if (result.classifier === "fallback") stats.fallbackUsed += 1;
    writeCachedLabels(deps.db, {
      itemId: item.id,
      contentHash: item.contentHash,
      questionSetVersion: QUESTION_SET_VERSION,
      model: deps.model,
      classifier: result.classifier,
      answers: Object.fromEntries(
        Object.entries(result.answers).map(([question, answer]) => [
          question,
          {
            answerJson: JSON.stringify(
              answer.kind === "choice"
                ? { kind: "choice", choice: answer.choice, confidence: answer.confidence }
                : { kind: "noul", noul: answer.noul },
            ),
            confidence: answer.kind === "choice" ? answer.confidence : answer.noul,
          },
        ]),
      ),
    });
    labeled.push({ itemId: item.id, labels: toItemLabels(result.answers, result.classifier, nicheAsked) });
  }
  return { labeled, stats };
}
