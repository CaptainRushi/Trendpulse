import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LlmClient,
  LlmHttpError,
  LlmTimeoutError,
  LlmValidationError,
} from "../../src/llm/client.js";
import type { LlmCallRecord, LlmClientOptions } from "../../src/llm/client.js";
import { FakeLlmServer } from "../fakes/fakeLlmServer.js";

const Sample = z.object({ ok: z.boolean() });

let server: FakeLlmServer;
let calls: LlmCallRecord[];
let slept: number[];

beforeEach(async () => {
  server = await FakeLlmServer.start();
  calls = [];
  slept = [];
});

afterEach(async () => {
  await server.stop();
});

function testClient(overrides: Partial<LlmClientOptions> = {}): LlmClient {
  return new LlmClient({
    baseUrl: server.url,
    apiKey: "test-key",
    model: "fake-model",
    clientName: "jev",
    timeoutMs: 5000,
    onCall: (rec) => {
      calls.push(rec);
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
}

describe("LlmClient.json", () => {
  it("parses valid JSON and logs usage", async () => {
    const client = testClient();
    const result = await client.json({
      system: "Return JSON only.",
      user: "hi",
      schema: Sample,
      tag: "test",
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.usage).toEqual({ tokensIn: 11, tokensOut: 7 });
    expect(result.repaired).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tag: "test", client: "jev", status: "ok", attempt: 1 });
  });

  it("strips code fences", async () => {
    server.enqueue({ rawContent: '```json\n{"ok": true}\n```' });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
  });

  it("tolerates trailing text after the JSON object", async () => {
    server.enqueue({ rawContent: '{"ok": true} hope this helps!' });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
  });

  it("repairs invalid JSON once (temperature 0) then succeeds", async () => {
    server.enqueue({ rawContent: "not json at all" });
    server.enqueue({ content: { ok: true } });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
    expect(result.repaired).toBe(true);
    expect(server.seen).toHaveLength(2);
    const repairBody = server.seen[1]?.body as { temperature?: number; messages?: { content: string }[] };
    expect(repairBody.temperature).toBe(0);
    expect(repairBody.messages?.some((m) => m.content.includes("valid JSON"))).toBe(true);
    expect(calls.map((c) => c.status)).toEqual(["invalid", "ok"]);
  });

  it("throws LlmValidationError when the repair also fails", async () => {
    server.enqueue({ rawContent: "garbage" });
    server.enqueue({ rawContent: "more garbage" });
    await expect(
      testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" }),
    ).rejects.toBeInstanceOf(LlmValidationError);
    expect(calls.map((c) => c.status)).toEqual(["invalid", "invalid"]);
  });

  it("treats null content as invalid and goes through repair", async () => {
    server.enqueue({ content: null });
    server.enqueue({ content: { ok: true } });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
    expect(result.repaired).toBe(true);
  });

  it("times out a hung endpoint", async () => {
    server.enqueue({ delayMs: 1500, content: { ok: true } });
    const client = testClient({ timeoutMs: 200, maxAttempts: 1 });
    await expect(
      client.json({ system: "s", user: "u", schema: Sample, tag: "t" }),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "timeout" });
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    server.enqueue({ status: 429, headers: { "retry-after": "5" }, content: { error: "slow down" } });
    server.enqueue({ content: { ok: true } });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
    expect(slept).toEqual([5000]);
  });

  it("backs off exponentially on 500s (1s, 2s)", async () => {
    server.enqueue({ status: 500, content: {} });
    server.enqueue({ status: 500, content: {} });
    server.enqueue({ content: { ok: true } });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.data).toEqual({ ok: true });
    expect(slept).toEqual([1000, 2000]);
  });

  it("retries refused connections up to maxAttempts then throws", async () => {
    await server.stop();
    const client = testClient({ maxAttempts: 2 });
    await expect(
      client.json({ system: "s", user: "u", schema: Sample, tag: "t" }),
    ).rejects.toBeInstanceOf(LlmHttpError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "http_error" });
  });

  it("sends model, response_format and auth header", async () => {
    await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    const req = server.lastRequest();
    const body = req?.body as Record<string, unknown>;
    expect(body["model"]).toBe("fake-model");
    expect(body["response_format"]).toEqual({ type: "json_object" });
    const auth = req?.headers["authorization"];
    expect(auth).toBe("Bearer test-key");
  });

  it("defaults missing usage to zero tokens", async () => {
    server.enqueue({ content: { ok: true }, usage: null });
    const result = await testClient().json({ system: "s", user: "u", schema: Sample, tag: "t" });
    expect(result.usage).toEqual({ tokensIn: 0, tokensOut: 0 });
  });

  it("does not retry validation failures as network errors", async () => {
    server.enqueue({ rawContent: "nope" });
    server.enqueue({ rawContent: "still nope" });
    const client = testClient({ maxAttempts: 4 });
    await expect(
      client.json({ system: "s", user: "u", schema: Sample, tag: "t" }),
    ).rejects.toBeInstanceOf(LlmValidationError);
    // Exactly 2 HTTP calls: initial + one repair, never a network retry loop.
    expect(server.seen).toHaveLength(2);
    expect(slept).toEqual([]);
  });
});
