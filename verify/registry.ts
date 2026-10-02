/**
 * Day-1 verify registry (docs/12 Prompt 1 task 8).
 * Entries: `{ id, feature, phase, tests[], run() }`.
 * Empty for now — the 23-row Day-1 board registers in Step 10.
 * The full fake-mode board currently lives in `scripts/verify.ts`
 * (superset from later phases); wiring it through this registry
 * happens with `check:plan` once the code has the full contract.
 */
export interface VerifyCheck {
  id: string;
  feature: string;
  phase: number;
  tests: string[];
  run: () => Promise<void>;
}

/** Day-1 starts empty; Step 10 fills the 23 rows from docs/12 §8. */
export const registry: VerifyCheck[] = [];

export interface VerifyResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIP";
  ms: number;
  error?: string;
}

/** Exit code for the runner: 1 on any FAIL, else 0. */
export function exitCodeFor(results: VerifyResult[]): number {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}
