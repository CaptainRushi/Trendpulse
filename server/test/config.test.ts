import { describe, expect, it } from "vitest";
import { loadConfig, resolveJevEndpoint } from "../src/config/env.js";

describe("loadConfig", () => {
  it("applies documented defaults for an empty env", () => {
    const config = loadConfig({});
    expect(config.port).toBe(4317);
    expect(config.host).toBe("127.0.0.1");
    expect(config.scheduleCron).toBe("0 6 * * *");
    expect(config.omnirouteBaseUrl).toBe("http://localhost:20128/v1");
    expect(config.jevBaseUrl).toBe("");
    expect(config.jevModel).toBe("jev");
    expect(config.sortBatchSize).toBe(30);
    expect(config.topN).toBe(50);
    expect(config.retentionMode).toBe("archive");
    expect(config.dedupeDays).toBe(3);
  });

  it("parses string booleans and numbers correctly", () => {
    const config = loadConfig({
      PORT: "9999",
      LOG_LLM_BODIES: "true",
      RUN_MISSED_ON_START: "false",
      AUTO_RESUME: "true",
      ENABLE_PLAYWRIGHT: "1",
      SHEET_CACHE_TTL_S: "120",
      LLM_CONCURRENCY: "4",
    });
    expect(config.port).toBe(9999);
    expect(config.logLlmBodies).toBe(true);
    expect(config.runMissedOnStart).toBe(false);
    expect(config.autoResume).toBe(true);
    expect(config.enablePlaywright).toBe(true);
    expect(config.sheetCacheTtlS).toBe(120);
    expect(config.llmConcurrency).toBe(4);
  });

  it("splits NICHES on commas and trims blanks", () => {
    expect(loadConfig({ NICHES: "" }).niches).toEqual([]);
    expect(loadConfig({ NICHES: "ai, startups ,, llm" }).niches).toEqual(["ai", "startups", "llm"]);
  });

  it("fails fast with a readable error on invalid values", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrowError(/PORT/i);
    expect(() => loadConfig({ RETENTION_MODE: "wipe" })).toThrowError(/RETENTION_MODE/i);
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrowError(/LOG_LEVEL/i);
  });

  it("requires DASHBOARD_PASSWORD when HOST is not loopback", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrowError(/DASHBOARD_PASSWORD/i);
    const config = loadConfig({ HOST: "0.0.0.0", DASHBOARD_PASSWORD: "s3cret" });
    expect(config.host).toBe("0.0.0.0");
  });
});

describe("resolveJevEndpoint", () => {
  it("routes Jev through OmniRoute when JEV_BASE_URL is empty", () => {
    const config = loadConfig({
      OMNIROUTE_BASE_URL: "http://localhost:20128/v1",
      OMNIROUTE_API_KEY: "omni-key",
      JEV_BASE_URL: "",
      JEV_MODEL: "jev",
    });
    const resolved = resolveJevEndpoint(config);
    expect(resolved.baseUrl).toBe("http://localhost:20128/v1");
    expect(resolved.apiKey).toBe("omni-key");
    expect(resolved.model).toBe("jev");
    expect(resolved.via).toBe("omniroute");
  });

  it("uses the dedicated Jev endpoint when JEV_BASE_URL is set", () => {
    const config = loadConfig({
      JEV_BASE_URL: "https://jev.example.com/v1",
      JEV_API_KEY: "jev-key",
      JEV_MODEL: "jev-1",
    });
    const resolved = resolveJevEndpoint(config);
    expect(resolved.baseUrl).toBe("https://jev.example.com/v1");
    expect(resolved.apiKey).toBe("jev-key");
    expect(resolved.via).toBe("direct");
  });
});
