/**
 * W-10: every API call in the client hits a documented shared route.
 * Scans lib/hooks/components/pages for api.get/post/put and EventSource
 * targets, normalizes `${...}` segments, and diffs against Day1Routes.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Day1Routes } from "@trendpulse/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function allSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function calledRoutes(): Set<string> {
  const found = new Set<string>();
  const callPattern = /(?:api\.(get|post|put)\s*\(\s*[`'"](\/api\/[^`"'?]+)|new\s+EventSource\(\s*[`'"](\/api\/[^`"'?]+))/g;
  for (const file of allSources(join(root, "src"))) {
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(callPattern)) {
      const method = match[3] !== undefined ? "GET" : (match[1] ?? "GET").toUpperCase();
      const raw = (match[3] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, ":p");
      found.add(`${method} ${raw}`);
    }
  }
  return found;
}

function contractRoutes(): Set<string> {
  return new Set(
    Day1Routes.map((route) => {
      const [method, path] = route.split(" ") as [string, string];
      return `${method} ${path.replace(/:[a-z_]+/g, ":p")}`;
    }),
  );
}

describe("api wiring", () => {
  it("W-10 every client call hits a documented route", () => {
    const called = calledRoutes();
    expect(called.size).toBeGreaterThan(0);
    const contract = contractRoutes();
    const undocumented = [...called].filter((route) => !contract.has(route));
    expect(undocumented, "client calls missing from shared Day1Routes").toEqual([]);
  });
});
