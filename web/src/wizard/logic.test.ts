import { describe, expect, it } from "vitest";
import {
  clearWizardState,
  defaultWizardState,
  loadWizardState,
  saveWizardState,
  stepCanContinue,
  WIZARD_STORAGE_KEY,
} from "./logic.js";

function storage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    clear: () => {
      store.clear();
    },
  };
}

describe("stepCanContinue", () => {
  it("welcome always continues; probe steps need passing tests", () => {
    const base = defaultWizardState();
    expect(stepCanContinue({ ...base, step: 0 })).toBe(true);
    expect(stepCanContinue({ ...base, step: 1 })).toBe(false);
    expect(stepCanContinue({ ...base, step: 1, tested: { ...base.tested, sheets: true } })).toBe(true);
    expect(stepCanContinue({ ...base, step: 2 })).toBe(false);
    expect(stepCanContinue({ ...base, step: 3 })).toBe(false);
  });

  it("sources needs a non-blank cron", () => {
    const base = defaultWizardState();
    expect(stepCanContinue({ ...base, step: 4 })).toBe(true);
    expect(
      stepCanContinue({ ...base, step: 4, sources: { ...base.sources, cron: "   " } }),
    ).toBe(false);
  });
});

describe("wizard persistence", () => {
  it("round-trips progress without probe flags", () => {
    const store = storage();
    const state = {
      ...defaultWizardState(),
      step: 2,
      jev: { base_url: "", api_key: "", model: "jev-1" },
      tested: { sheets: true, omniroute: true, jev: false },
    };
    saveWizardState(store, state);
    const loaded = loadWizardState(store);
    expect(loaded.step).toBe(2);
    expect(loaded.jev.model).toBe("jev-1");
    expect(loaded.tested).toEqual({ sheets: false, omniroute: false, jev: false });
    expect(store.getItem(WIZARD_STORAGE_KEY)).not.toContain("tested");
  });

  it("falls back to defaults on corrupt or foreign shapes", () => {
    expect(loadWizardState(storage({ [WIZARD_STORAGE_KEY]: "{oops" })).step).toBe(0);
    expect(loadWizardState(storage({ [WIZARD_STORAGE_KEY]: "[1,2]" })).step).toBe(0);
    expect(loadWizardState(storage({ [WIZARD_STORAGE_KEY]: JSON.stringify({ step: 99 }) })).step).toBe(0);
  });

  it("clears progress", () => {
    const store = storage();
    saveWizardState(store, defaultWizardState());
    clearWizardState(store);
    expect(store.getItem(WIZARD_STORAGE_KEY)).toBeNull();
  });
});
