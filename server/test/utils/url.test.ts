import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../../src/utils/url.js";

describe("canonicalizeUrl", () => {
  it("strips utm_* and common tracking params, keeps the rest", () => {
    expect(
      canonicalizeUrl("https://Example.com/Story?utm_source=x&utm_medium=y&fbclid=abc&id=7"),
    ).toBe("https://example.com/Story?id=7");
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/a#section-2")).toBe("https://example.com/a");
  });

  it("lowercases scheme and host", () => {
    expect(canonicalizeUrl("HTTPS://EXAMPLE.com/A")).toBe("https://example.com/A");
  });

  it("sorts remaining query params for stability", () => {
    expect(canonicalizeUrl("https://e.com/p?b=2&a=1")).toBe("https://e.com/p?a=1&b=2");
  });

  it("strips a trailing slash but keeps the root path", () => {
    expect(canonicalizeUrl("https://e.com/a/")).toBe("https://e.com/a");
    expect(canonicalizeUrl("https://e.com/")).toBe("https://e.com/");
  });

  it("rejects non-http(s) schemes", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("ftp://example.com/x")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });

  it("keeps non-tracking params like ref when not in the strip list", () => {
    // ref= is only stripped by reddit's own rules in normalize (Phase 4);
    // canonicalization itself keeps unknown params.
    expect(canonicalizeUrl("https://e.com/a?ref=home")).toBe("https://e.com/a?ref=home");
  });
});
