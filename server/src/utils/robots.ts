/**
 * Minimal robots.txt parser + matcher (RFC 9309 subset we need).
 * Used for `webpage` and `rss` page fetches (TRD §4.3); API endpoints are exempt.
 */

export interface RobotsRules {
  /** Longest-match wins; Allow wins ties (Google's rule). */
  isAllowed(path: string): boolean;
}

interface Group {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
}

function patternToRegExp(pattern: string): RegExp {
  // robots patterns support * (any run) and $ (end anchor); everything else literal.
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "*") source += ".*";
    else if (ch === "$" && i === pattern.length - 1) source += "$";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}`);
}

/**
 * Parse robots.txt body into a matcher for one user-agent. Unknown directives
 * ignored. Missing/empty body → everything allowed.
 */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  // Consecutive User-agent lines share one group; a rule line closes the agent list.
  let agentsOnly = true;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (line === "") continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      if (current === null || !agentsOnly) {
        current = { agents: [], rules: [] };
        groups.push(current);
        agentsOnly = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      agentsOnly = false;
      // Empty Disallow means "allow all" — skip it (pattern "" would match nothing anyway).
      if (value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    }
    // sitemap/crawl-delay/etc: ignored.
  }

  const ua = userAgent.toLowerCase();
  // Specific group wins over "*": first group (in file order) mentioning our agent
  // exactly; else the "*" group.
  const own =
    groups.find((g) => g.agents.some((a) => a !== "*" && (ua.includes(a) || a.includes(ua)))) ??
    groups.find((g) => g.agents.includes("*"));

  const rules = own?.rules ?? [];

  return {
    isAllowed(path: string): boolean {
      let best: { allow: boolean; len: number } | null = null;
      for (const rule of rules) {
        const re = patternToRegExp(rule.pattern);
        if (re.test(path)) {
          const len = rule.pattern.length;
          if (best === null || len > best.len || (len === best.len && rule.allow)) {
            best = { allow: rule.allow, len };
          }
        }
      }
      // No matching rule → allowed (including empty ruleset).
      return best === null || best.allow;
    },
  };
}
