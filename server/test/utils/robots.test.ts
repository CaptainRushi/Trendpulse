import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRobots } from "../../src/utils/robots.js";

const fixtureDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const read = (name: string): string => readFileSync(fixtureDir + name, "utf8");

describe("parseRobots", () => {
  it("allows everything when no rule matches", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private", "MyBot/1.0");
    expect(rules.isAllowed("/public")).toBe(true);
    expect(rules.isAllowed("/private")).toBe(false);
  });

  it("empty body allows everything", () => {
    const rules = parseRobots("", "MyBot/1.0");
    expect(rules.isAllowed("/anything")).toBe(true);
  });

  it("empty Disallow means allow all", () => {
    const rules = parseRobots("User-agent: *\nDisallow:", "MyBot/1.0");
    expect(rules.isAllowed("/anything")).toBe(true);
  });

  it("longest match wins; allow wins ties", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /a\nDisallow: /a/b\nAllow: /a/b",
      "MyBot/1.0",
    );
    expect(rules.isAllowed("/a")).toBe(false);
    expect(rules.isAllowed("/a/b")).toBe(true);
    expect(rules.isAllowed("/a/b/c")).toBe(true);
  });

  it("specific user-agent group beats *", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: MyBot\nAllow: /",
      "MyBot/2.0",
    );
    expect(rules.isAllowed("/x")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow: /", "OtherBot/1.0").isAllowed("/x")).toBe(false);
  });

  it("wildcard * and end-anchor $ patterns", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*", "B");
    expect(rules.isAllowed("/docs/report.pdf")).toBe(false);
    expect(rules.isAllowed("/docs/report.pdf/extra")).toBe(true);
    expect(rules.isAllowed("/tmp/a/b")).toBe(false);
    expect(rules.isAllowed("/tmpx")).toBe(true);
  });

  it("ignores comments and unknown directives", () => {
    const rules = parseRobots("# comment\nUser-agent: *\nCrawl-delay: 10\nDisallow: /x # trailing", "B");
    expect(rules.isAllowed("/x")).toBe(false);
    expect(rules.isAllowed("/y")).toBe(true);
  });

  it("matches the recorded wikipedia robots fixture", () => {
    const rules = parseRobots(read("robots_wikipedia.txt"), "TrendPulse/1.0");
    expect(rules.isAllowed("/wiki/Komorebi")).toBe(true); // normal articles allowed
    expect(rules.isAllowed("/wiki/Special:Search")).toBe(false); // Disallow: /wiki/Special:
    expect(rules.isAllowed("/wiki/Wikipedia:Reliable_sources/Noticeboard")).toBe(false);
    expect(rules.isAllowed("/w/")).toBe(false);
  });

  it("matches the recorded ycombinator robots fixture", () => {
    const rules = parseRobots(read("hn_robots.txt"), "TrendPulse/1.0");
    expect(rules.isAllowed("/")).toBe(true);
    expect(rules.isAllowed("/verify/abc")).toBe(false);
  });
});
