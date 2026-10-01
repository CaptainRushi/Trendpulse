/**
 * Minimal .env read/write for the setup CLI. Parsing stays compatible
 * with dotenv (KEY=value, single/double quotes, # comments); writing
 * preserves existing lines and comments, updating known keys in place
 * and appending new ones. Secrets are never logged by callers.
 */

export function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    const key = match?.[1];
    if (!key) continue;
    map.set(key, unquote((match[2] ?? "").trim()));
  }
  return map;
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Quote values containing spaces, # or quotes so dotenv reads them back. */
export function serializeEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Update KEY= lines in place (comments and unknown lines untouched),
 * appending keys that are not present yet.
 */
export function upsertEnvLines(existing: string[], values: Map<string, string>): string[] {
  const remaining = new Map(values);
  const out = existing.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (match?.[1] && remaining.has(match[1])) {
      const key = match[1];
      remaining.delete(key);
      return `${key}=${serializeEnvValue(values.get(key) ?? "")}`;
    }
    return line;
  });
  if (remaining.size > 0) {
    if (out.length > 0 && (out[out.length - 1]?.trim() ?? "") !== "") out.push("");
    out.push("# Added by npm run setup");
    for (const [key, value] of remaining) out.push(`${key}=${serializeEnvValue(value)}`);
  }
  return out;
}
