/**
 * Design-token conformance (docs/11 §6.2). CSS, tokens.json and the
 * CLAUDE.md table share one source — this test fails the build if they
 * drift. Titles carry their docs/07 + docs/11 test IDs.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = here;
const srcDir = join(here, "..");

function readStyles(name: string): string {
  return readFileSync(join(stylesDir, name), "utf-8");
}

/** Exact token table from CLAUDE.md — the source of truth. */
const CLAUDE_TOKENS: Record<string, string> = {
  bg: "#F5F5F0",
  panel: "#FFFFFF",
  line: "#E2E2D9",
  "line-2": "#EEEEE7",
  ink: "#121210",
  "ink-2": "#3B3B37",
  muted: "#6F6F68",
  faint: "#A6A69D",
  lime: "#DCEB63",
  "lime-ink": "#2B3300",
  "lime-bg": "#F3F8D6",
  "lime-deep": "#5E6A1C",
  forest: "#14291D",
  "forest-ink": "#E8F0D6",
  "forest-muted": "#9DB39F",
  violet: "#7A6AD8",
  good: "#2F7D3B",
  warn: "#B7791F",
  bad: "#B42318",
  info: "#1F6FB2",
};

function cssVars(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const key = match[1];
    if (key && match[2] !== undefined) out[key] = match[2].trim();
  }
  return out;
}

function allFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

describe("design tokens", () => {
  it("STY-01 CSS variables equal tokens.json equal the CLAUDE.md table", () => {
    const css = readStyles("tokens.css");
    const vars = cssVars(css);
    const json = JSON.parse(readStyles("tokens.json")) as Record<string, string>;
    expect(json).toEqual(CLAUDE_TOKENS);
    for (const [key, value] of Object.entries(CLAUDE_TOKENS)) {
      expect(vars[key], `--${key}`).toBe(value);
    }
    const extra = Object.keys(vars).filter((k) => !(k in CLAUDE_TOKENS) && !["font-ui", "font-mono", "radius", "color-scheme"].includes(k));
    expect(extra).toEqual([]);
  });

  it("STY-05 prefers-reduced-motion disables animation and transitions", () => {
    const css = readStyles("app.css");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    const block = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/transition:\s*none/);
  });

  it("STY-04 fonts are self-hosted: no external hosts, local files load", () => {
    for (const css of [readStyles("tokens.css"), readStyles("app.css")]) {
      expect(css).not.toMatch(/url\(\s*["']?https?:/);
      expect(css).not.toMatch(/@import\s+["']https?:/);
    }
    const require = createRequire(import.meta.url);
    for (const pkg of ["@fontsource-variable/geist", "@fontsource-variable/geist-mono"]) {
      const cssPath = require.resolve(`${pkg}/index.css`);
      const css = readFileSync(cssPath, "utf-8");
      expect(css).toMatch(/@font-face/);
      const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] ?? "");
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).not.toMatch(/https?:/);
    }
    const main = readFileSync(join(srcDir, "main.tsx"), "utf-8");
    expect(main).toContain("@fontsource-variable/geist");
    expect(main).toContain("@fontsource-variable/geist-mono");
  });

  it("W-23 components share the token source: no raw hex outside tokens.css", () => {
    expect(readStyles("app.css")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const offenders: string[] = [];
    for (const file of allFiles(srcDir, ".tsx")) {
      const text = readFileSync(file, "utf-8");
      if (/#[0-9a-fA-F]{6}\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    const css = readStyles("app.css");
    const json = JSON.parse(readStyles("tokens.json")) as Record<string, string>;
    // Sanctioned non-uses: faint is decorative/disabled-only (never text),
    // violet is the chart comparison series (no charts on Day-1 pages).
    const exempt: Record<string, string> = {
      faint: "decorative and disabled only",
      violet: "chart comparison series",
    };
    for (const key of Object.keys(json)) {
      if (key in exempt) continue;
      expect(css.includes(`var(--${key})`), `var(--${key}) used`).toBe(true);
    }
  });
});
