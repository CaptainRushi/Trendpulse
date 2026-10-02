import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testJevConnection, testOmnirouteConnection } from "../../src/llm/probe.js";
import { FakeJevServer } from "../fakes/fakeJevServer.js";
import { FakeLlmServer } from "../fakes/fakeLlmServer.js";

let primary: FakeLlmServer;
let fallback: FakeLlmServer;
let jev: FakeJevServer;

beforeEach(async () => {
  primary = await FakeLlmServer.start();
  fallback = await FakeLlmServer.start();
  jev = await FakeJevServer.start("ok");
});

afterEach(async () => {
  await primary.stop();
  await fallback.stop();
  await jev.stop();
});

describe("testOmnirouteConnection", () => {
  it("lists models on success", async () => {
    primary.enqueue({ models: ["jev", "extract-1"] });
    const result = await testOmnirouteConnection({ baseUrl: primary.url, apiKey: "k" });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ models: ["jev", "extract-1"] });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("reports unreachable hosts actionably", async () => {
    await primary.stop();
    const result = await testOmnirouteConnection({ baseUrl: primary.url });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not reachable/i);
  });

  it("reports bad credentials actionably", async () => {
    primary.enqueue({ status: 401, content: { error: "bad key" } });
    const result = await testOmnirouteConnection({ baseUrl: primary.url, apiKey: "wrong" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unauthorized|api key/i);
  });

  it("times out fast with a small timeout", async () => {
    primary.enqueue({ delayMs: 1500 });
    const result = await testOmnirouteConnection({ baseUrl: primary.url, timeoutMs: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/i);
  });
});

describe("testJevConnection", () => {
  it("classifies a sample against a direct SystemOne endpoint", async () => {
    const result = await testJevConnection({
      baseUrl: jev.url,
      path: "",
      apiKey: "k",
      model: "jev-1",
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ ok: true, model: "jev-1" });
    expect(jev.seen).toHaveLength(1);
    const body = jev.seen[0]?.body as { model?: unknown; state?: unknown; questions?: unknown };
    expect(body.model).toBe("jev-1");
    expect(body.state).toBeTypeOf("object");
    expect(body.questions).toBeTypeOf("object");
  });

  it("tolerates a pasted full endpoint URL", async () => {
    const result = await testJevConnection({
      baseUrl: `${jev.url}/v1/systemone`,
      apiKey: "k",
      model: "jev-1",
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ ok: true, model: "jev-1" });
  });

  it("falls back to the OmniRoute base URL when JEV_BASE_URL is empty", async () => {
    const result = await testJevConnection({
      baseUrl: "",
      model: "jev-via-gateway",
      fallback: { baseUrl: fallback.url, apiKey: "omni-key" },
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ ok: true, model: "jev-via-gateway" });
    expect(primary.seen).toHaveLength(0);
    expect(fallback.seen).toHaveLength(1);
  });

  it("requires a model id", async () => {
    const result = await testJevConnection({ baseUrl: jev.url, model: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/model/i);
    expect(jev.seen).toHaveLength(0);
  });

  it("surfaces invalid sample replies as failures, not crashes", async () => {
    jev.enqueue({ rawBody: "garbage" });
    const result = await testJevConnection({ baseUrl: jev.url, path: "", model: "jev-1", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/answers|envelope|json|HTTP/i);
  });
});
