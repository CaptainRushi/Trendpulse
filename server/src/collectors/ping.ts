/** Shared doctor ping helpers (collectors/ping.ts — no cycles with registry). */
import type { PingResult } from "./types.js";
import type { GetOptions, HttpClient } from "./http.js";

/** One GET at `url`; 200-range → ok. Never throws. */
export async function httpPing(
  http: HttpClient,
  url: string,
  headers?: Record<string, string>,
): Promise<PingResult> {
  try {
    const options: GetOptions = { timeoutMs: 10_000 };
    if (headers) options.headers = headers;
    const res = await http.get(url, options);
    return res.status >= 200 && res.status < 300
      ? { ok: true, detail: `HTTP ${String(res.status)}` }
      : { ok: false, detail: `HTTP ${String(res.status)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Ping result for a collector that needs user config but has none yet. */
export function needsConfig(detail: string): PingResult {
  return { ok: false, detail };
}
