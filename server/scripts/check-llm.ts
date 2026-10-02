/**
 * check:llm — live contract check (docs/12 Prompt 3 task 8).
 * With keys: GET OmniRoute /models + one real Jev SystemOne classification of
 * a synthetic sample item, prints both, saves the sanitized Jev response to
 * server/test/fixtures/jev/real-sample.json (the JEV-03 fixture). Without
 * keys: prints "no keys yet" and exits 0 (fakes cover CI).
 *
 * Contract mismatch (real Jev shape ≠ CLAUDE.md) exits 2 with both shapes —
 * STOP, adjust the client + docs/11 §1.1, do not guess past it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { loadConfig } from "../src/config/env.js";
import { LlmClient } from "../src/llm/client.js";

dotenv.config();
const here = dirname(fileURLToPath(import.meta.url));
// Workspace scripts run with cwd=server/, so the repo-root .env is not found
// by default — load it explicitly (machine env still wins; dotenv never overrides).
dotenv.config({ path: join(here, "..", "..", ".env") });

const fixtureDir = join(here, "..", "test", "fixtures", "jev");

const ChoiceAnswer = z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number() });
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });
const SystemOneResponse = z.object({ answers: z.record(z.union([ChoiceAnswer, NoulAnswer])) });

const SAMPLE_STATE = {
  title: "Local bakery launches a sourdough subscription",
  snippet: "A neighborhood bakery now offers weekly sourdough delivery.",
  source: "rss",
  published_at: "2026-10-02T06:00:00Z",
};
const SAMPLE_QUESTIONS = {
  category: {
    type: "choice",
    instructions: "Which category best fits this item?",
    criteria: { Lifestyle: "food and daily life", Tech: "technology", none: "no category fits" },
  },
  quality: { type: "noul", instructions: "Is this substantive, not spam?" },
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.omnirouteApiKey === "") {
    process.stdout.write("no keys yet (OMNIROUTE_API_KEY empty; Jev check needs JEV_API_KEY too)\n");
    return;
  }
  const omni = new LlmClient({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    model: "",
    clientName: "extractor",
    timeoutMs: 15000,
    maxAttempts: 1,
  });
  try {
    const models = await omni.listModels();
    process.stdout.write(`omniroute models (${String(models.length)}): ${models.slice(0, 10).join(", ")}\n`);
  } catch (error) {
    process.stdout.write(`omniroute /models failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (config.jevBaseUrl === "" || config.jevApiKey === "") {
    process.stdout.write("no Jev direct key yet (JEV_BASE_URL/JEV_API_KEY empty) — skipping live classification\n");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.llmTimeoutMs);
  let raw: unknown;
  try {
    const response = await fetch(`${config.jevBaseUrl.replace(/\/+$/, "")}${config.jevPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.jevApiKey}` },
      body: JSON.stringify({ model: config.jevModel, state: SAMPLE_STATE, questions: SAMPLE_QUESTIONS }),
      signal: controller.signal,
    });
    raw = (await response.json()) as unknown;
    process.stdout.write(`jev HTTP ${String(response.status)}\n`);
  } finally {
    clearTimeout(timer);
  }
  const parsed = SystemOneResponse.safeParse(raw);
  process.stdout.write(`jev response: ${JSON.stringify(raw).slice(0, 500)}\n`);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    process.stdout.write(
      `CONTRACT MISMATCH vs CLAUDE.md {answers:{name:{type:"choice",choice,confidence}|{type:"noul",noul}}}: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unreadable"}\n`,
    );
    process.exit(2);
  }
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "real-sample.json"),
    `${JSON.stringify({ request: { model: config.jevModel, state: SAMPLE_STATE, questions: SAMPLE_QUESTIONS }, response: parsed.data }, null, 2)}\n`,
  );
  process.stdout.write("saved server/test/fixtures/jev/real-sample.json (sanitized: no key material)\n");
}

await main();
