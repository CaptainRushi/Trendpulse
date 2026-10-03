/**
 * Sidecar supervisor: spawns `python app.py` with a per-boot token,
 * waits for /health, restarts at most 3 times in 5 minutes, then gives
 * up; 3 consecutive health failures open a 60s circuit breaker.
 * A process-wide holder lets the webpage collector reach the client
 * without threading it through every context (set at boot, nulled in tests).
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { ScraplingClient } from "./client.js";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;
const COOLDOWN_MS = 60_000;
const START_TIMEOUT_MS = 45_000;

export interface SupervisorOptions {
  baseUrl: string;
  enabled: boolean;
  /** Defaults to <repo>/scrapling-service. */
  serviceDir?: string;
  pythonBin?: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ScraplingSupervisor {
  readonly token = randomBytes(32).toString("hex");
  private readonly options: SupervisorOptions;
  private child: ChildProcess | null = null;
  private exited = false;
  private dead = false; // restart budget spent — client() stays null
  private restarts: number[] = [];
  private consecutiveFailures = 0;
  private coolUntil = 0;
  private readonly clientInstance: ScraplingClient | null;

  constructor(options: SupervisorOptions) {
    this.options = { sleep: defaultSleep, ...options };
    this.clientInstance = options.enabled
      ? new ScraplingClient(options.baseUrl, this.token, options.fetchImpl)
      : null;
  }

  /** Null when disabled, given up, or cooling down — callers degrade, never throw. */
  client(): ScraplingClient | null {
    if (!this.clientInstance || this.dead || Date.now() < this.coolUntil) return null;
    return this.clientInstance;
  }

  /** Spawn and wait for healthy (throws when the restart budget is spent). */
  async start(): Promise<void> {
    if (!this.clientInstance) return;
    await this.spawn();
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (await this.clientInstance.healthy(2000)) {
        this.consecutiveFailures = 0;
        return;
      }
      if (this.exited) this.noteExit();
      if (this.dead) throw new Error("sidecar restart budget spent (3 in 5 minutes)");
      if (Date.now() > deadline) throw new Error("sidecar did not become healthy in time");
      await this.options.sleep?.(500);
    }
  }

  /** Cheap liveness for collectors: healthy, or restart-with-budget, else null. */
  async ensureHealthy(): Promise<ScraplingClient | null> {
    const direct = this.client();
    if (!direct) return null;
    if (await direct.healthy(3000)) {
      this.consecutiveFailures = 0;
      return direct;
    }
    this.consecutiveFailures += 1;
    if (this.exited) this.noteExit();
    if (this.consecutiveFailures >= 3) {
      this.coolUntil = Date.now() + COOLDOWN_MS; // ponytail: fixed cooldown, no jitter — localhost only
      this.options.log?.warn("scrapling circuit open for 60s after 3 failed health checks");
      return null;
    }
    try {
      await this.spawn();
      return direct;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.exited = true;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private serviceDir(): string {
    if (this.options.serviceDir) return this.options.serviceDir;
    const here = dirname(fileURLToPath(import.meta.url)); // server/src/scraping
    return join(here, "..", "..", "..", "scrapling-service");
  }

  private pythonBin(): string {
    if (this.options.pythonBin) return this.options.pythonBin;
    // Prefer the service venv (it holds the pinned deps); fall back to PATH.
    const venv = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
    const candidate = join(this.serviceDir(), "venv", venv);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      return process.platform === "win32" ? "python" : "python3";
    }
  }

  private noteExit(): void {
    this.exited = true;
    this.child = null;
    const now = Date.now();
    this.restarts = [...this.restarts.filter((t) => now - t < RESTART_WINDOW_MS), now];
    if (this.restarts.length > MAX_RESTARTS) {
      this.dead = true;
      this.options.log?.error("scrapling sidecar exceeded 3 restarts in 5 minutes; giving up");
    }
  }

  private async spawn(): Promise<void> {
    if (this.dead) throw new Error("restart budget spent");
    await this.stop();
    this.exited = false;
    const child = spawn(this.pythonBin(), ["app.py"], {
      cwd: this.serviceDir(),
      env: { ...process.env, SCRAPLING_TOKEN: this.token },
      stdio: "ignore",
      windowsHide: true,
    });
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) this.noteExit();
    });
    child.once("error", () => {
      if (this.child === child) this.noteExit();
    });
  }
}

let active: ScraplingSupervisor | null = null;

/** Set once at boot (index.ts); tests swap in fakes. */
export function setScrapingSupervisor(supervisor: ScraplingSupervisor | null): void {
  active = supervisor;
}

/** The boot supervisor's client, or null when the sidecar is off/down. */
export function scrapingClient(): ScraplingClient | null {
  return active?.client() ?? null;
}

/** Proactive variant: restarts a dead sidecar within budget, else null. */
export async function ensureScraping(): Promise<ScraplingClient | null> {
  if (!active) return null;
  return active.ensureHealthy();
}
