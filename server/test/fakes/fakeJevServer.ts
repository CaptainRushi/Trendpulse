/**
 * SystemOne HTTP double for Jev tests. Records requests (method, path,
 * auth header presence, parsed body) and answers from the request's own
 * questions so choice/noul coercion paths are exercisable. Queue entries
 * override the modal default once each: script 429→500→200 sequences.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type FakeJevMode =
  | "ok"
  | "missing_answer"
  | "bad_choice"
  | "http429"
  | "http500"
  | "timeout"
  | "injection_echo";

export interface QueuedJevResponse {
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Explicit answers object; default responder used when absent. */
  answers?: Record<string, unknown>;
  /** Verbatim body (for envelope-shape mismatches). */
  rawBody?: string;
}

export interface SeenJevRequest {
  method: string;
  path: string;
  hasBearerAuth: boolean;
  body: { model: unknown; state: unknown; questions: unknown };
}

interface DecodedBody {
  model?: unknown;
  state?: Record<string, unknown> | undefined;
  questions?: Record<string, { type?: unknown; instructions?: unknown; criteria?: Record<string, unknown> }> | undefined;
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

export class FakeJevServer {
  readonly url: string;
  readonly seen: SeenJevRequest[] = [];
  mode: FakeJevMode;
  private readonly queue: QueuedJevResponse[] = [];
  private readonly server: Server;
  private stopped = false;

  private constructor(server: Server, url: string, mode: FakeJevMode) {
    this.server = server;
    this.url = url;
    this.mode = mode;
  }

  static async start(mode: FakeJevMode = "ok"): Promise<FakeJevServer> {
    const holder: { current?: FakeJevServer } = {};
    const server = createServer((req, res) => {
      void holder.current?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake jev failed to bind");
    const fake = new FakeJevServer(server, `http://127.0.0.1:${String(address.port)}`, mode);
    holder.current = fake;
    return fake;
  }

  enqueue(response: QueuedJevResponse): void {
    this.queue.push(response);
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
    let decoded: DecodedBody = {};
    try {
      decoded = (rawBody === "" ? {} : JSON.parse(rawBody)) as DecodedBody;
    } catch {
      decoded = {};
    }
    const auth = req.headers["authorization"];
    this.seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      hasBearerAuth: typeof auth === "string" && auth.startsWith("Bearer "),
      body: { model: decoded.model, state: decoded.state, questions: decoded.questions },
    });

    const next = this.queue.shift();
    const status = next?.status ?? (this.mode === "http429" ? 429 : this.mode === "http500" ? 500 : 200);
    const delay = next?.delayMs ?? (this.mode === "timeout" ? 5000 : 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    for (const [key, value] of Object.entries(next?.headers ?? {})) res.setHeader(key, value);
    res.writeHead(status, { "content-type": "application/json" });
    if (status !== 200) {
      res.end(JSON.stringify({ error: `fake ${String(status)}` }));
      return;
    }
    if (next?.rawBody !== undefined) {
      res.end(next.rawBody);
      return;
    }
    res.end(JSON.stringify({ answers: next?.answers ?? this.defaultAnswers(decoded) }));
  }

  private defaultAnswers(decoded: DecodedBody): Record<string, unknown> {
    const questions = decoded.questions ?? {};
    const names = Object.keys(questions);
    const out: Record<string, unknown> = {};
    names.forEach((name, i) => {
      const q = questions[name];
      if (q?.type === "noul") {
        out[name] = { type: "noul", noul: 0.8 };
        return;
      }
      if (this.mode === "missing_answer" && i === 0) return;
      if (this.mode === "bad_choice" && i === 0) {
        out[name] = { type: "choice", choice: "not-a-criterion", confidence: 0.7 };
        return;
      }
      if (this.mode === "injection_echo" && i === 0) {
        const state = decoded.state ?? {};
        const rawTitle = state["title"] ?? state["transcript"] ?? "echo";
        const echo = (typeof rawTitle === "string" ? rawTitle : JSON.stringify(rawTitle)).slice(0, 60);
        out[name] = { type: "choice", choice: echo, confidence: 0.99 };
        return;
      }
      const keys = q?.criteria !== undefined ? Object.keys(q.criteria) : [];
      out[name] = { type: "choice", choice: keys[0] ?? "none", confidence: 0.9 };
    });
    return out;
  }
}
