/**
 * ScraplingClient — thin JSON wrapper over the lite sidecar.
 * The sidecar owns every guard (SSRF, robots, rate limit); this client
 * only frames requests, times out, and validates the response shape.
 */
import { z } from "zod";

const ScrapeOk = z.object({
  status: z.literal("ok"),
  url: z.string(),
  mode_used: z.string(),
  html: z.string(),
  truncated: z.boolean(),
  took_ms: z.number(),
});
const ScrapeBlocked = z.object({ status: z.literal("blocked"), reason: z.string() });
const ScrapeFailed = z.object({ status: z.literal("error"), reason: z.string() });
const ScrapeResultSchema = z.union([ScrapeOk, ScrapeBlocked, ScrapeFailed]);
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

export interface ScrapeOptions {
  url: string;
  mode?: "auto" | "http" | "browser";
  waitFor?: string;
  timeoutMs?: number;
}

export class ScraplingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "X-Internal-Token": this.token };
  }

  async healthy(timeoutMs = 5000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: unknown };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async fetchPage(options: ScrapeOptions): Promise<ScrapeResult> {
    const timeoutMs = options.timeoutMs ?? 45000;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/fetch`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          url: options.url,
          mode: options.mode ?? "auto",
          ...(options.waitFor ? { wait_for: options.waitFor } : {}),
          timeout_ms: timeoutMs,
        }),
        signal: AbortSignal.timeout(timeoutMs + 15000),
      });
    } catch (error) {
      throw new Error(`sidecar unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 401) throw new Error("sidecar rejected our token");
    if (!res.ok) throw new Error(`sidecar HTTP ${String(res.status)}`);
    const parsed = ScrapeResultSchema.safeParse((await res.json()) as unknown);
    if (!parsed.success) throw new Error("sidecar returned an unknown shape");
    return parsed.data;
  }
}
