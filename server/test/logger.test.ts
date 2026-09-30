import { describe, expect, it } from "vitest";
import { createLogger, REDACT_PATHS } from "../src/utils/logger.js";

describe("logger redaction", () => {
  it("declares redact paths covering all secret families", () => {
    const joined = REDACT_PATHS.join(" ").toLowerCase();
    for (const needle of ["api_key", "password", "token", "secret", "authorization"]) {
      expect(joined).toContain(needle);
    }
  });

  it("never emits secret values to the output stream", async () => {
    let captured = "";
    const stream = {
      write(chunk: string): boolean {
        captured += chunk;
        return true;
      },
    };
    // Level must be info: an "error"-level logger would drop the info log
    // entirely and the test would pass vacuously.
    const logger = createLogger("info", stream);
    logger.info(
      {
        OMNIROUTE_API_KEY: "omni-super-secret",
        JEV_API_KEY: "jev-super-secret",
        DASHBOARD_PASSWORD: "dash-super-secret",
        nested: { GITHUB_TOKEN: "gh-super-secret" },
      },
      "boot",
    );
    // pino writes through an async buffer — flush before asserting.
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured).not.toContain("omni-super-secret");
    expect(captured).not.toContain("jev-super-secret");
    expect(captured).not.toContain("dash-super-secret");
    expect(captured).not.toContain("gh-super-secret");
    expect(captured).toContain("[Redacted]");
  });
});
