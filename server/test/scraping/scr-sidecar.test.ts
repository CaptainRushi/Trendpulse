/**
 * S1 sidecar tests: real Python service + local fixture site on loopback.
 * The sidecar runs with SCRAPLING_ALLOW_IPS=127.0.0.1,::1 (test-only holes
 * for the fixture server; production leaves it unset = deny-all).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ScraplingClient } from "../../src/scraping/client.js";
import { ScraplingSupervisor } from "../../src/scraping/supervisor.js";
import { assertPublicUrl } from "../../src/scraping/guard.js";
import { webpageCollector } from "../../src/collectors/webpage.js";
import { fakeExtractor, makeCtx } from "../collectors/helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serviceDir = join(repoRoot, "scrapling-service");
const venvPython = process.platform === "win32"
  ? join(serviceDir, "venv", "Scripts", "python.exe")
  : join(serviceDir, "venv", "bin", "python");

const ARTICLE = `<html><head><title>Static headline</title></head><body><article><h1>Static headline</h1><p>${"lorem ipsum dolor sit amet ".repeat(30)}</p></article></body></html>`;
const JS_SHELL = `<html><head><title>js</title></head><body><div id="app"></div><script>document.getElementById('app').innerHTML = '<article><h1>Rendered headline</h1><p>${"rendered body text ".repeat(30)}</p></article>';</script></body></html>`;

let site: Server | null = null;
let sitePort = 0;
let supervisor: ScraplingSupervisor | null = null;
let token = "";

/** Live client (beforeAll throws when the sidecar is not up). */
function client(): ScraplingClient {
  const live = supervisor?.client();
  if (!live) throw new Error("sidecar not up");
  return live;
}

async function startSite(): Promise<number> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\n");
    } else if (url.pathname === "/static") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(ARTICLE);
    } else if (url.pathname === "/js") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(JS_SHELL);
    } else if (url.pathname === "/private") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(ARTICLE);
    } else if (url.pathname === "/forbidden") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("nope");
    } else if (url.pathname === "/redirect-private") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site = server;
  return (server.address() as AddressInfo).port;
}

const savedAllow = process.env["SCRAPLING_ALLOW_IPS"];

beforeAll(async () => {
  if (!existsSync(venvPython)) throw new Error(`sidecar venv missing: ${venvPython}`);
  process.env["SCRAPLING_ALLOW_IPS"] = "127.0.0.1,::1";
  sitePort = await startSite();
  supervisor = new ScraplingSupervisor({ baseUrl: "http://127.0.0.1:4318", enabled: true, pythonBin: venvPython });
  await supervisor.start();
  token = supervisor.token;
}, 120_000);

afterAll(async () => {
  if (savedAllow === undefined) delete process.env["SCRAPLING_ALLOW_IPS"];
  else process.env["SCRAPLING_ALLOW_IPS"] = savedAllow;
  await supervisor?.stop();
  await new Promise<void>((resolve) => {
    site?.close(() => {
      resolve();
    });
  });
}, 30_000);

const page = (path: string): string => `http://127.0.0.1:${String(sitePort)}${path}`;

describe("sidecar auth", () => {
  it("SCR-01 requests without (or with a wrong) token get 401", async () => {
    const bare = await fetch("http://127.0.0.1:4318/health");
    expect(bare.status).toBe(401);
    const wrong = await fetch("http://127.0.0.1:4318/health", { headers: { "X-Internal-Token": "wrong" } });
    expect(wrong.status).toBe(401);
    expect(client()).not.toBeNull();
  });
});

describe("sidecar fetch", () => {
  it("SCR-02 static page fetches over plain http", async () => {
    const result = await client().fetchPage({ url: page("/static"), mode: "http" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.mode_used).toBe("http");
    expect(result.html).toContain("Static headline");
  }, 60_000);

  it("SCR-03 JS-rendered page escalates to the browser under auto", async () => {
    const result = await client().fetchPage({ url: page("/js"), mode: "auto" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.mode_used).toBe("browser");
    expect(result.html).toContain("Rendered headline");
  }, 120_000);

  it("SCR-04 robots-disallowed path is blocked without fetching", async () => {
    const result = await client().fetchPage({ url: page("/private"), mode: "http" });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.reason).toMatch(/robots/i);
  }, 60_000);

  it("SCR-10 a 403 is BLOCKED, never worked around", async () => {
    const result = await client().fetchPage({ url: page("/forbidden"), mode: "http" });
    expect(result.status).toBe("blocked");
  }, 60_000);

  it("SCR-14 SSRF cases are blocked", async () => {
    for (const url of [
      "http://10.255.255.1/",
      "http://metadata.google.internal/",
      page("/redirect-private"),
    ]) {
      const result = await client().fetchPage({ url, mode: "http", timeoutMs: 15000 });
      expect(result.status, url).toBe("blocked");
    }
    const allowed = await client().fetchPage({ url: page("/static"), mode: "http" });
    expect(allowed.status).toBe("ok");
  }, 120_000);

  it("SCR-18 stealth mode is rejected with 400", async () => {
    const res = await fetch("http://127.0.0.1:4318/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": token },
      body: JSON.stringify({ url: page("/static"), mode: "stealth" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("guard units (no network)", () => {
  it("SCR-14 assertPublicUrl rejects non-public targets", async () => {
    delete process.env["SCRAPLING_ALLOW_IPS"];
    try {
      for (const url of [
        "http://127.0.0.1/x",
        "http://10.1.2.3/",
        "http://169.254.169.254/",
        "http://localhost:4318/",
        "ftp://example.com/x",
        "not-a-url",
      ]) {
        await expect(assertPublicUrl(url), url).rejects.toThrow();
      }
    } finally {
      process.env["SCRAPLING_ALLOW_IPS"] = "127.0.0.1,::1";
    }
  });

  it("SCR-14 assertPublicUrl accepts a public literal and the test allowlist", async () => {
    await expect(assertPublicUrl("http://93.184.216.1/")).resolves.toBeTruthy();
    process.env["SCRAPLING_ALLOW_IPS"] = "127.0.0.1,::1";
    await expect(assertPublicUrl("http://127.0.0.1:9/")).resolves.toBeTruthy();
    delete process.env["SCRAPLING_ALLOW_IPS"];
    await expect(assertPublicUrl("http://127.0.0.1:9/")).rejects.toThrow();
    process.env["SCRAPLING_ALLOW_IPS"] = "127.0.0.1,::1";
  });
});

describe("policy surface", () => {
  it("SCR-18 no stealth capability is imported by the service", () => {
    // Import lines only: the words "stealth"/policy appear in comments and
    // the mode-400 path, which must stay greppable-but-harmless.
    const source = readFileSync(join(serviceDir, "app.py"), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*(import|from)\s+/.test(line));
    for (const line of imports) {
      expect(line).not.toMatch(/stealthy|camoufox|cloudflare|turnstile|proxy_rotat|browserforge|fingerprint/i);
    }
    expect(source).not.toContain("StealthyFetcher");
  });
});

describe("supervisor", () => {
  it("a disabled supervisor has no client", () => {
    const off = new ScraplingSupervisor({ baseUrl: "http://127.0.0.1:4318", enabled: false });
    expect(off.client()).toBeNull();
    expect(off.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("three failed health checks open the circuit", async () => {
    const flaky = new ScraplingSupervisor({
      baseUrl: "http://127.0.0.1:9",
      enabled: true,
      pythonBin: "definitely-not-python-xyz",
      serviceDir: repoRoot,
      fetchImpl: () => Promise.resolve(new Response("x", { status: 500 })),
      sleep: () => Promise.resolve(),
    });
    expect(flaky.client()).not.toBeNull();
    await flaky.ensureHealthy();
    await flaky.ensureHealthy();
    expect(await flaky.ensureHealthy()).toBeNull();
    expect(flaky.client()).toBeNull();
    await flaky.stop();
  }, 30_000);
});

describe("webpage collector", () => {
  it("COL-07 collects an article through the sidecar", async () => {
    const nativeCalls: string[] = [];
    const fetchImpl = ((input: unknown): Promise<Response> => {
      nativeCalls.push(String(input));
      throw new Error("native fetch must not run on the sidecar path");
    }) as typeof fetch;
    const llm = fakeExtractor({ title: "Sidecar title", snippet: "Sidecar snippet.", language: "en", is_article: true });
    const ctx = makeCtx({
      fetchImpl,
      llm,
      config: { pages: [page("/static")] },
      scraping: new ScraplingClient("http://127.0.0.1:4318", token),
    });
    const { items, stats } = await webpageCollector.collect(ctx);
    expect(stats.status).toBe("ok");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Sidecar title");
    expect(nativeCalls).toEqual([]);
    expect(llm.calls).toBe(1);
  }, 60_000);
});
