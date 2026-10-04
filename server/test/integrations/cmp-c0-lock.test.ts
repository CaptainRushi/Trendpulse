import { describe, expect, it } from "vitest";
import { checkToolLock, isPinnedVersion, loadToolLock, requireOpSlug } from "../../src/integrations/composio/tool-map.js";
import { ComposioError } from "../../src/integrations/composio/errors.js";

describe("CMP-03 unpinned lock blocks execution", () => {
  it("shipped lock loads and is UNPINNED", () => {
    const lock = loadToolLock();
    expect(lock.toolkit).toBe("googlesheets");
    expect(isPinnedVersion(lock.version)).toBe(false);
  });

  it("requireOpSlug throws COMPOSIO_TOOL_MISSING on the unpinned lock", () => {
    const lock = loadToolLock();
    let thrown: unknown;
    try {
      requireOpSlug(lock, "appendRows");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ComposioError);
    expect((thrown as ComposioError).code).toBe("COMPOSIO_TOOL_MISSING");
  });

  it("missing slug and deprecated slug are reported", () => {
    const lock = loadToolLock();
    const missing = checkToolLock({ ...lock, ops: {} });
    expect(missing.some((p) => p.includes("appendRows"))).toBe(true);
    const deprecated = checkToolLock({
      ...lock,
      version: "20260817_00",
      ops: { ...lock.ops, appendRows: { slug: "GOOGLESHEETS_BATCH_UPDATE", params: [] } },
    });
    expect(deprecated.some((p) => p.includes("deprecated"))).toBe(true);
  });

  it("dated version with all ops passes", () => {
    const lock = loadToolLock();
    expect(checkToolLock({ ...lock, version: "20260817_00" })).toEqual([]);
    expect(requireOpSlug({ ...lock, version: "20260817_00" }, "appendRows")).toBe(
      "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
    );
  });
});
