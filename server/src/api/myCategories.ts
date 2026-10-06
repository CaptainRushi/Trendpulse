/**
 * My-categories settings (Doc 19 Q1): the ordered category selection that
 * drives collection, sorting and the Today panels. Empty = onboarding, no
 * run starts (preflight NO_CATEGORIES_SELECTED, enforced by the pipeline).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "./errors.js";
import type { AppContext } from "./context.js";
import { validateMyCategories } from "../categories/registry.js";
import {
  effectiveIncludeGeneralSources,
  effectiveMaxCategories,
  effectiveTopPerCategory,
  readMyCategories,
  writeSetting,
} from "../config/settings.js";

export function registerMyCategories(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/my-categories", () => ({
    my_categories: readMyCategories(ctx.db),
    max_categories: effectiveMaxCategories(ctx.db, ctx.config),
    top_per_category: effectiveTopPerCategory(ctx.db, ctx.config),
    include_general_sources: effectiveIncludeGeneralSources(ctx.db, ctx.config),
  }));

  app.put("/api/my-categories", (request) => {
    const parsed = z.object({ my_categories: z.array(z.unknown()) }).safeParse(request.body);
    if (!parsed.success) throw badRequest("Body must be { my_categories: [...] }.");
    const maxCats = effectiveMaxCategories(ctx.db, ctx.config);
    let clean: string[];
    try {
      clean = validateMyCategories(parsed.data.my_categories, maxCats);
    } catch (error) {
      throw badRequest(
        `Invalid my_categories: ${error instanceof Error ? error.message : "invalid categories"}.`,
      );
    }
    writeSetting(ctx.db, "my_categories", clean);
    return { my_categories: clean };
  });
}
