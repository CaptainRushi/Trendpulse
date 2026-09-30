/**
 * LlmExtractor — OmniRoute-backed page extraction (TRD §4.1 CollectContext.llm,
 * §8.1 extractor contract). One instance per collect run, model from config.
 */
import { z } from "zod";
import { EXTRACTOR_SYSTEM } from "./prompts/extract.js";
import type { LlmClient } from "./client.js";

export const ExtractedPage = z.object({
  title: z.string(),
  snippet: z.string(),
  published_at: z.string().nullable(),
  entities: z.array(z.string()).max(8),
  language: z.string(),
  is_article: z.boolean(),
});
export type ExtractedPage = z.infer<typeof ExtractedPage>;

export interface LlmExtractor {
  readonly model: string;
  extract(input: { text: string; url: string; tag?: string }): Promise<ExtractedPage>;
}

export function createExtractor(client: LlmClient): LlmExtractor {
  return {
    model: client.modelId,
    async extract({ text, url, tag }) {
      const { data } = await client.json({
        system: EXTRACTOR_SYSTEM,
        user: `URL: ${url}\n\nTEXT:\n<<<\n${text.slice(0, 120_000)}\n>>>`,
        schema: ExtractedPage,
        tag: tag ?? "extract",
      });
      return data;
    },
  };
}
