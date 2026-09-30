import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
  githubCollector,
  githubItemToDraft,
} from "../../src/collectors/github.js";
import { fixture, fixtureJson, makeCtx, urlOf } from "./helpers.js";
import type { GitHubItem } from "../../src/collectors/github.js";

describe("buildSearchQuery", () => {
  it("queries repos created in the last 7 days, stars first", () => {
    const q = buildSearchQuery(new Date("2026-09-30T12:00:00Z"));
    expect(q).toBe("created:>2026-09-23 sort:stars-desc");
  });
});

describe("githubItemToDraft", () => {
  it("maps stars → engagement_score and forks → engagement", () => {
    const recorded = fixtureJson("github_search.json") as { items: GitHubItem[] };
    const item = recorded.items[0];
    expect(item).toBeDefined();
    const draft = githubItemToDraft(item!);
    expect(draft.source).toBe("github");
    expect(draft.engagement_score).toBe(item!.stargazers_count);
    expect(draft.engagement.forks).toBe(item!.forks_count);
    expect(draft.author).toBe(item!.owner?.login);
    expect(draft.published_at).toMatch(/^\d{4}-/);
    expect(draft.language).toBeTruthy();
  });
});

describe("githubCollector", () => {
  it("collects from the recorded search response", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      fetchImpl: (input: RequestInfo | URL) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response(fixture("github_search.json"), { status: 200 }));
      },
      limit: 5,
    });
    const { items, stats } = await githubCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(stats.source).toBe("github");
    expect(items.length).toBe(5);
    // search query carries the 7-day window and star sort
    expect(decodeURIComponent(calls[0] ?? "")).toContain("created:>");
    expect(decodeURIComponent(calls[0] ?? "")).toContain("sort:stars-desc");
    expect(items.every((i) => i.url.startsWith("https://github.com/"))).toBe(true);
  });

  it("sends the auth header when a token is configured", async () => {
    let auth: string | undefined;
    const ctx = makeCtx({
      fetchImpl: (_input: RequestInfo | URL, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return Promise.resolve(new Response(fixture("github_search.json"), { status: 200 }));
      },
      config: { github_token: "gh-secret" },
    });
    await githubCollector.collect(ctx);
    expect(auth).toBe("Bearer gh-secret");
  });

  it("returns an error stat on non-200 (rate limit, bad creds)", async () => {
    const ctx = makeCtx({
      fetchImpl: () => Promise.resolve(new Response("rate limited", { status: 403 })),
    });
    const { stats } = await githubCollector.collect(ctx);
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("403");
  });
});
