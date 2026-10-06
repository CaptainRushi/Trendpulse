/**
 * Category registry API (Doc 17 S1): list with source status, edit sources
 * per category. Overrides live in the `category_sources` settings key.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "./errors.js";
import type { AppContext } from "./context.js";
import { readSettingsMap } from "../config/settings.js";
import {
  CATEGORY_REGISTRY,
  CATEGORY_SLUGS,
  effectiveSources,
  validateCategorySources,
  type CategorySource,
} from "../categories/registry.js";
import { writeSetting } from "../config/settings.js";
import { categoryOverrides } from "../categories/collect.js";

function sourceStatus(ctx: AppContext, collector: string): { usable: boolean; hint: string } {
  if (collector === "reddit") {
    const usable = ctx.config.redditClientId !== "" && ctx.config.redditClientSecret !== "";
    return { usable, hint: usable ? "" : "needs Reddit OAuth (REDDIT_CLIENT_ID/SECRET)" };
  }
  if (collector === "github") {
    return {
      usable: true,
      hint: ctx.config.githubToken === "" ? "anonymous: 10 search requests/min" : "",
    };
  }
  return { usable: true, hint: "" };
}

export function registerCategories(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/categories", () => {
    const overrides = categoryOverrides(ctx.db);
    const defaults = readSettingsMap(ctx.db).get("default_categories");
    return {
      categories: (CATEGORY_SLUGS as readonly string[]).map((slug) => {
        const entry = CATEGORY_REGISTRY[slug];
        if (!entry) throw notFound(`No category '${slug}'.`);
        const sources = effectiveSources(slug, overrides);
        return {
          slug,
          label: entry.label,
          sources: sources.map((source) => ({ ...source, ...sourceStatus(ctx, source.collector) })),
        };
      }),
      default_categories: Array.isArray(defaults) ? defaults : [],
    };
  });

  app.put<{ Params: { slug: string } }>("/api/categories/:slug", (request) => {
    const slug = request.params.slug.toLowerCase();
    if (!(CATEGORY_SLUGS as readonly string[]).includes(slug)) throw notFound(`No category '${slug}'.`);
    const parsed = z.object({ sources: z.array(z.unknown()).max(3) }).safeParse(request.body);
    if (!parsed.success) throw badRequest("Body must be { sources: [...] } (at most 3).");
    let validated: Record<string, CategorySource[]>;
    try {
      validated = validateCategorySources({ [slug]: parsed.data.sources });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "invalid sources");
    }
    const current = categoryOverrides(ctx.db);
    writeSetting(ctx.db, "category_sources", { ...current, ...validated });
    return { slug, sources: validated[slug] };
  });
}
