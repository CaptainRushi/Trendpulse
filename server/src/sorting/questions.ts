/**
 * Day-1 sorter question set (docs/11 §1.3, Step-6 task 1). Version "q1" —
 * part of the LabelCache key, so prompt edits invalidate cached labels.
 */
import type { JevQuestions } from "../llm/jev.js";

export const QUESTION_SET_VERSION = "q1";

const CATEGORY_CRITERIA: Record<string, string> = {
  Tech: "technology, gadgets, software, internet culture",
  AI: "artificial intelligence, machine learning, LLMs",
  Business: "companies, startups, markets, work",
  Finance: "money, investing, banking, crypto",
  Science: "research, space, physics, biology",
  Health: "medicine, fitness, nutrition, wellbeing",
  Politics: "government, elections, policy",
  World: "international news, conflicts, diplomacy",
  Sports: "games, athletes, leagues, scores",
  Entertainment: "movies, music, celebrities, streaming",
  Culture: "arts, books, design, society trends",
  Gaming: "video games, esports, consoles",
  Lifestyle: "food, travel, home, fashion, daily life",
  Other: "does not fit any category above",
  none: "not classifiable from the given text",
};

/** niche_fit is asked ONLY when niches are set (else relevance falls back to quality). */
export function buildQuestions(niches: string[]): JevQuestions {
  const questions: JevQuestions = {
    category: {
      type: "choice",
      instructions: "Which category best fits this item?",
      criteria: CATEGORY_CRITERIA,
    },
    quality: {
      type: "noul",
      instructions:
        "Is this a substantive item worth a content creator's attention, not spam, an advertisement or empty noise?",
    },
    novelty: {
      type: "noul",
      instructions: "Is this about something new in the last 48 hours rather than evergreen or recurring?",
    },
    sentiment: {
      type: "choice",
      instructions: "What is the sentiment of this item?",
      criteria: {
        positive: "optimistic, praising, upbeat",
        neutral: "factual, balanced, no clear tone",
        negative: "critical, alarming, pessimistic",
        mixed: "both positive and negative tones",
      },
    },
  };
  if (niches.length > 0) {
    questions["niche_fit"] = {
      type: "noul",
      instructions: `Does this item fit these niches: ${niches.join(", ")}?`,
    };
  }
  return questions;
}
