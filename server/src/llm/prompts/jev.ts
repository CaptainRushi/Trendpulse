/**
 * Writer + digest prompts. The map/reduce Jev prompts were retired with the
 * old sorter (Step 7 rewire, docs/11): classification prompts now live in
 * sorting/questions.ts (q1 set) and the writer prompt in
 * sorting/writeTopics.ts (verbatim Day-1 text).
 */
export { PROMPT_VERSION } from "./extract.js";

export const JEV_DIGEST_SYSTEM =
  "Write a 3–5 sentence factual summary of today's top topics for a content creator. Use only the provided topics. No hype. JSON: {\"digest\": string}";
