/**
 * Day-1 health board (docs/12 §8 — exactly these 23 rows).
 * Each row names its required tests; `fake` runs them via vitest `-t`
 * against fakes, `live` probes real services where credentials exist
 * (rows without probes and without `local` SKIP in live mode).
 */
export interface FileGroup {
  ws: "server" | "web";
  files: string[];
  pattern: string;
}

export type LiveProbe =
  | { kind: "sheets-tabs" }
  | { kind: "ping"; source: "hackernews" | "reddit" | "google_trends" | "github" | "rss" }
  | { kind: "jev-sample" }
  | { kind: "connection-probes" };

export interface BoardRow {
  id: string;
  feature: string;
  tests: string[];
  /** Fake-mode vitest groups (all must exit 0). Local rows also run these in live mode. */
  fake: FileGroup[];
  /** True when every fake group is credential-free (sqlite, mocks, CSS). */
  local?: boolean;
  /** Live-mode real-service probes (each may PASS/FAIL/SKIP). */
  live?: LiveProbe[];
  note?: string;
}

const S = (files: string[], pattern: string): FileGroup => ({ ws: "server", files, pattern });
const W = (files: string[], pattern: string): FileGroup => ({ ws: "web", files, pattern });

export const registry: BoardRow[] = [
  { id: "F02", feature: "Sheet tabs auto-created", tests: ["SHT-01", "SHT-02"],
    fake: [S(["test/sheets/sht-step2.test.ts"], "SHT-01|SHT-02")], live: [{ kind: "sheets-tabs" }] },
  { id: "F03", feature: "Hacker News", tests: ["COL-01"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-01")], live: [{ kind: "ping", source: "hackernews" }] },
  { id: "F04", feature: "Reddit", tests: ["COL-02"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-02")], live: [{ kind: "ping", source: "reddit" }] },
  { id: "F05", feature: "Google Trends", tests: ["COL-03"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-03")], live: [{ kind: "ping", source: "google_trends" }] },
  { id: "F06", feature: "GitHub", tests: ["COL-04"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-04")], live: [{ kind: "ping", source: "github" }] },
  { id: "F08", feature: "RSS", tests: ["COL-06"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-06")], live: [{ kind: "ping", source: "rss" }] },
  { id: "F10", feature: "Source failure isolation", tests: ["COL-08", "RUN-03"],
    fake: [S(["test/collectors/col-step4.test.ts"], "COL-08"), S(["test/pipeline/run-step7.test.ts"], "RUN-03")],
    local: true },
  { id: "F13", feature: "Canonicalize and dedupe", tests: ["NRM-01", "NRM-02", "NRM-03", "NRM-04", "NRM-05"],
    fake: [S(["test/pipeline/nrm-step5.test.ts"], "NRM-01|NRM-02|NRM-03|NRM-04|NRM-05")], local: true },
  { id: "F14", feature: "Engagement normalization", tests: ["NRM-06", "NRM-07"],
    fake: [S(["test/pipeline/nrm-step5.test.ts"], "NRM-06|NRM-07")], local: true },
  { id: "F15", feature: "Raw rows written", tests: ["SHT-03", "SHT-16"],
    fake: [S(["test/sheets/sht-step2.test.ts"], "SHT-03|SHT-16")],
    note: "live needs a sheet-backed run" },
  { id: "F16", feature: "Clustering and topic text", tests: ["SRT-01", "SRT-02", "SRT-03", "SRT-04"],
    fake: [S(["test/sorting/srt-step6.test.ts"], "SRT-01|SRT-02|SRT-03|SRT-04")],
    note: "live needs a sheet-backed run" },
  { id: "F17", feature: "Score and rank", tests: ["SRT-05", "SRT-06", "SRT-07", "SRT-14"],
    fake: [S(["test/sorting/srt-step6.test.ts"], "SRT-05|SRT-06|SRT-07|SRT-14")],
    note: "live needs a sheet-backed run" },
  { id: "F18", feature: "Bad Jev or writer output handled", tests: ["SRT-08", "LLM-06", "LLM-07"],
    fake: [S(["test/sorting/srt-step6.test.ts"], "SRT-08"), S(["test/llm/llm-step3.test.ts"], "LLM-06|LLM-07")],
    note: "live needs a sheet-backed run" },
  { id: "F19", feature: "Daily digest", tests: ["SRT-10"],
    fake: [S(["test/sorting/srt-step6.test.ts"], "SRT-10")],
    note: "live needs a sheet-backed run" },
  { id: "F20", feature: "Sorted rows and latest flag", tests: ["SHT-08", "SRT-15"],
    fake: [S(["test/sheets/sht-step2.test.ts"], "SHT-08"), S(["test/sorting/srt-step6.test.ts"], "SRT-15")],
    note: "live needs a sheet-backed run" },
  { id: "F23", feature: "Single run lock", tests: ["RUN-07", "RUN-08"],
    fake: [S(["test/pipeline/run-step7.test.ts"], "RUN-07|RUN-08")], local: true },
  { id: "F26", feature: "Live progress", tests: ["RUN-12", "UI-04"],
    fake: [S(["test/pipeline/run-step7.test.ts"], "RUN-12"), W(["src/hooks/useEventSource.test.ts"], "UI-04")],
    local: true },
  { id: "F27", feature: "Today page", tests: ["UI-02", "UI-03"],
    fake: [W(["src/pages/Today.test.tsx"], "UI-02|UI-03")], local: true },
  { id: "F28", feature: "Topic side panel", tests: ["UI-05"],
    fake: [W(["src/pages/Today.test.tsx"], "UI-05")], local: true },
  { id: "F32", feature: "Settings with connection tests", tests: ["UI-11", "API-11", "API-12"],
    fake: [W(["src/pages/Settings.test.tsx"], "UI-11"), S(["test/api/api-step8.test.ts"], "API-11|API-12")],
    local: true, live: [{ kind: "connection-probes" }] },
  { id: "J01", feature: "Jev typed classification", tests: ["JEV-01", "JEV-02", "JEV-03", "JEV-04", "JEV-05", "JEV-06", "JEV-08", "JEV-09", "JEV-10", "JEV-11", "JEV-13"],
    fake: [S(["test/llm/llm-step3.test.ts"], "JEV-01|JEV-02|JEV-04|JEV-05|JEV-06|JEV-08|JEV-09|JEV-10|JEV-11|JEV-13")],
    live: [{ kind: "jev-sample" }],
    note: "JEV-03 runs only when the real-response fixture exists" },
  { id: "J02", feature: "Fallback classifier", tests: ["JEV-07", "JEV-12"],
    fake: [S(["test/llm/llm-step3.test.ts"], "JEV-07|JEV-12")],
    note: "live fallback needs a manual wrong-key run" },
  { id: "U01", feature: "Design tokens conformance (Day-1 subset)", tests: ["STY-01", "STY-03", "STY-04", "STY-05"],
    fake: [W(["src/styles/tokens.test.ts"], "STY-01|STY-04|STY-05")], local: true,
    note: "STY-03 cut per the Day-1 cut order (see DECISIONS.md)" },
];

export interface VerifyResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIP";
  ms: number;
  detail?: string;
}

/** Exit code for the runner: 1 on any FAIL, else 0. */
export function exitCodeFor(results: VerifyResult[]): number {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}
