import { describe, expect, it } from "vitest";
import { parseEnvText, serializeEnvValue, upsertEnvLines } from "../../src/config/envFile.js";

describe("parseEnvText", () => {
  it("reads KEY=value lines, skips comments and blanks, strips quotes", () => {
    const map = parseEnvText(
      '# comment\nPORT=4317\nEMPTY=\nQUOTED="a b#c"\nSINGLE=\'x\'\nnot-a-key\n',
    );
    expect(map.get("PORT")).toBe("4317");
    expect(map.get("EMPTY")).toBe("");
    expect(map.get("QUOTED")).toBe("a b#c");
    expect(map.get("SINGLE")).toBe("x");
    expect(map.has("not-a-key")).toBe(false);
  });
});

describe("serializeEnvValue", () => {
  it("quotes only when needed, round-tripping through the parser", () => {
    for (const value of ["plain", "http://x:8080/v1", "a b", "x#y", 'say "hi"']) {
      const serialized = serializeEnvValue(value);
      expect(parseEnvText(`K=${serialized}`).get("K")).toBe(value);
    }
    expect(serializeEnvValue("plain")).toBe("plain");
  });
});

describe("upsertEnvLines", () => {
  it("updates in place, preserves comments, appends missing keys", () => {
    const out = upsertEnvLines(
      ["# header", "PORT=1111", "", "UNKNOWN=keep"],
      new Map([
        ["PORT", "4317"],
        ["TZ", "UTC"],
      ]),
    );
    expect(out).toEqual(["# header", "PORT=4317", "", "UNKNOWN=keep", "", "# Added by npm run setup", "TZ=UTC"]);
  });

  it("never touches commented KEY= lines", () => {
    const out = upsertEnvLines(["#PORT=1"], new Map([["PORT", "2"]]));
    expect(out).toEqual(["#PORT=1", "", "# Added by npm run setup", "PORT=2"]);
  });
});
