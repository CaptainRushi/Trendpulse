import { describe, expect, it } from "vitest";
import { contentHash, sha1 } from "../../src/utils/hash.js";

describe("sha1", () => {
  it("matches a known digest", () => {
    expect(sha1("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});

describe("contentHash", () => {
  it("uses the canonical URL when present", () => {
    expect(contentHash("https://example.com/a", "ignored")).toBe(
      contentHash("https://example.com/a", "different title"),
    );
  });

  it("falls back to a normalized title when no URL", () => {
    const h1 = contentHash(null, "  Hello   World  ");
    const h2 = contentHash(null, "hello world");
    expect(h1).toBe(h2);
  });

  it("different titles hash differently", () => {
    expect(contentHash(null, "alpha")).not.toBe(contentHash(null, "beta"));
  });
});
