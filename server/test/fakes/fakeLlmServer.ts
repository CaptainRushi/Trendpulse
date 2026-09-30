/**
 * Minimal OpenAI-compatible HTTP double for LLM tests. Serves chat
 * completions POSTs and models GETs, records every request, and replays
 * queued responses in order so tests can script 429s, timeouts (delayMs),
 * fenced/truncated/invalid JSON, and repairs.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface QueuedLlmResponse {
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Object → JSON-stringified as message content. */
  content?: unknown;
  /** Verbatim message content (fences, trailing text, garbage). */
  rawContent?: string;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  models?: string[];
}

export interface SeenLlmRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: unknown) => {
      data += String(chunk);
    });
    req.on("end", () => {
      resolve(data);
    });
    req.on("error", (error: Error) => {
      reject(error);
    });
  });
}

export class FakeLlmServer {
  readonly url: string;
  readonly seen: SeenLlmRequest[] = [];
  private readonly queue: QueuedLlmResponse[] = [];
  private readonly server: Server;
  private stopped = false;

  private constructor(server: Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(): Promise<FakeLlmServer> {
    const holder: { current?: FakeLlmServer } = {};
    const server = createServer((req, res) => {
      void holder.current?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake LLM failed to bind");
    const fake = new FakeLlmServer(server, `http://127.0.0.1:${String(address.port)}/v1`);
    holder.current = fake;
    return fake;
  }

  enqueue(response: QueuedLlmResponse): void {
    this.queue.push(response);
  }

  lastRequest(): SeenLlmRequest | undefined {
    return this.seen[this.seen.length - 1];
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    let body: unknown = null;
    try {
      body = rawBody === "" ? null : (JSON.parse(rawBody) as unknown);
    } catch {
      body = rawBody;
    }
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
    this.seen.push({ method: req.method ?? "", path: req.url ?? "", headers, body });

    const next = this.queue.shift() ?? {};
    if (next.delayMs !== undefined && next.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }
    for (const [key, value] of Object.entries(next.headers ?? {})) res.setHeader(key, value);
    const status = next.status ?? 200;
    if ((req.method ?? "") === "GET" && (req.url ?? "").endsWith("/models")) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: (next.models ?? ["fake-model"]).map((id) => ({ id })) }));
      return;
    }
    const content =
      next.rawContent !== undefined
        ? next.rawContent
        : "content" in next
          ? next.content === null
            ? null
            : JSON.stringify(next.content)
          : JSON.stringify({ ok: true });
    const envelope: Record<string, unknown> = {
      id: "chatcmpl-fake",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content } }],
      model: "fake",
    };
    if (next.usage !== null) {
      envelope["usage"] = next.usage ?? { prompt_tokens: 11, completion_tokens: 7 };
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(envelope));
  }
}
