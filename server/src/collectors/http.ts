/**
 * Shared collector HTTP client (plan Phase 3): User-Agent, timeout, retry with
 * backoff honoring Retry-After, per-domain rate limit, optional ETag cache and
 * robots.txt gate. No cookies, no credentials to third parties (TRD §4.3).
 */
import { parseRobots, type RobotsRules } from "../utils/robots.js";
import { DomainRateLimiter, type RateLimiterOptions } from "../utils/rate-limit.js";
import { redactUrlForLog } from "../utils/url.js";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** True when the ETag cache satisfied the request (HTTP 304). */
  notModified: boolean;
  /** True when robots.txt disallowed the URL (status is 403, nothing fetched). */
  robotsBlocked?: boolean;
}

export interface GetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Send If-None-Match/If-Modified-Since from the cache and honor 304. */
  etag?: boolean;
  /** Fetch + enforce robots.txt for this URL's origin. */
  robots?: boolean;
  /** Override the per-domain gap for this request (HN's concurrency 8 → 0). */
  gapMs?: number;
}

/** Persistence for ETag/Last-Modified (SQLite `http_cache` in prod, Map in tests). */
export interface EtagCacheStore {
  get(url: string): Promise<{ etag: string | null; last_modified: string | null } | null>;
  set(url: string, etag: string | null, lastModified: string | null): Promise<void>;
}

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
  limiter?: DomainRateLimiter;
  limiterOptions?: RateLimiterOptions;
  cache?: EtagCacheStore;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly limiter: DomainRateLimiter;
  private readonly cache: EtagCacheStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** origin → parsed robots.txt (or null when unfetchable → allow). */
  private readonly robotsCache = new Map<string, RobotsRules | null>();

  constructor(options: HttpClientOptions) {
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.limiter = options.limiter ?? new DomainRateLimiter(options.limiterOptions);
    this.cache = options.cache;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(url: string, options: GetOptions = {}): Promise<HttpResponse> {
    if (options.robots && !(await this.isAllowed(url))) {
      return { status: 403, headers: {}, text: "", notModified: false, robotsBlocked: true };
    }

    const conditional = options.etag ? await this.cache?.get(url) : null;
    const domain = new URL(url).hostname;

    return this.limiter.run(
      domain,
      async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
          const headers: Record<string, string> = {
            "user-agent": this.userAgent,
            ...options.headers,
          };
          if (conditional?.etag) headers["if-none-match"] = conditional.etag;
          if (conditional?.last_modified) headers["if-modified-since"] = conditional.last_modified;

          let response: Response;
          try {
            response = await this.fetchOnce(url, headers, options.timeoutMs ?? this.timeoutMs);
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < this.maxAttempts) {
              await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
              continue;
            }
            break;
          }

          if (response.status === 304) {
            return { status: 304, headers: {}, text: "", notModified: true };
          }

          if (response.status === 429 || response.status >= 500) {
            lastError = new HttpError(`HTTP ${String(response.status)} for ${redactUrlForLog(url)}`, redactUrlForLog(url), response.status);
            if (attempt < this.maxAttempts) {
              const retryAfter = Number(response.headers.get("retry-after"));
              const wait =
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? retryAfter * 1000
                  : this.retryBaseMs * 2 ** (attempt - 1);
              await this.sleep(wait);
              continue;
            }
            break;
          }

          const text = await response.text();
          if (options.etag && this.cache && response.status === 200) {
            await this.cache.set(url, response.headers.get("etag"), response.headers.get("last-modified"));
          }
          return {
            status: response.status,
            headers: headerMap(response),
            text,
            notModified: false,
          };
        }
        throw lastError ?? new HttpError(`request failed for ${redactUrlForLog(url)}`, redactUrlForLog(url), 0);
      },
      options.gapMs,
    );
  }

  /** Form-encoded POST (Reddit OAuth token endpoint). Same limiter/retry as GET. */
  async postForm(
    url: string,
    body: string,
    options: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<HttpResponse> {
    const domain = new URL(url).hostname;
    return this.limiter.run(domain, async () => {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        const headers: Record<string, string> = {
          "user-agent": this.userAgent,
          "content-type": "application/x-www-form-urlencoded",
          ...options.headers,
        };
        let response: Response;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => {
            controller.abort();
          }, options.timeoutMs ?? this.timeoutMs);
          try {
            response = await this.fetchImpl(url, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
              redirect: "follow",
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < this.maxAttempts) {
            await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
            continue;
          }
          break;
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = new HttpError(`HTTP ${String(response.status)} for ${redactUrlForLog(url)}`, redactUrlForLog(url), response.status);
          if (attempt < this.maxAttempts) {
            await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
            continue;
          }
          break;
        }
        return {
          status: response.status,
          headers: headerMap(response),
          text: await response.text(),
          notModified: false,
        };
      }
      throw lastError ?? new HttpError(`request failed for ${redactUrlForLog(url)}`, redactUrlForLog(url), 0);
    });
  }

  private async fetchOnce(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * robots.txt gate: fetch once per origin (TTL-free per process — runs are short).
   * Fetch failure (404/5xx/timeout) → allow: robots.txt absence means no restrictions,
   * and a transient error must not silently drop the user's configured URLs.
   */
  private async isAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const origin = parsed.origin;
    let rules = this.robotsCache.get(origin);
    if (rules === undefined) {
      rules = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, this.timeoutMs);
        try {
          const res = await this.fetchImpl(`${origin}/robots.txt`, {
            headers: { "user-agent": this.userAgent },
            signal: controller.signal,
            redirect: "follow",
          });
          if (res.ok) rules = parseRobots(await res.text(), this.userAgent);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        rules = null;
      }
      this.robotsCache.set(origin, rules);
    }
    if (rules === null) return true;
    return rules.isAllowed(parsed.pathname + parsed.search);
  }
}

function headerMap(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
