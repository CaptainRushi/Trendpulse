import type { DestinationStream } from "pino";
import pino from "pino";

/**
 * Every key name that may carry a credential. pino/fast-redact matches exact
 * paths, so each key is registered at the top level and up to three levels
 * deep ("*" = any single parent key). Why broad: third-party payloads (LLM
 * usage, collector errors) can nest tokens under unexpected parents;
 * redaction must not depend on our own object shape.
 */
const SECRET_KEYS: string[] = [
  "api_key",
  "apiKey",
  "API_KEY",
  "OMNIROUTE_API_KEY",
  "JEV_API_KEY",
  "YOUTUBE_API_KEY",
  "password",
  "PASSWORD",
  "passwd",
  "dashboardPassword",
  "DASHBOARD_PASSWORD",
  "token",
  "TOKEN",
  "GITHUB_TOKEN",
  "PRODUCTHUNT_TOKEN",
  "secret",
  "SECRET",
  "client_secret",
  "clientSecret",
  "REDDIT_CLIENT_SECRET",
  "authorization",
  "Authorization",
  "service_account",
  "serviceAccount",
  "private_key",
  "privateKey",
];

export const REDACT_PATHS: string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.*.${k}`),
];

export function createLogger(level = "info", destination?: DestinationStream): pino.Logger {
  // pino forbids combining a transport with an explicit destination stream,
  // so pretty-printing only applies when the caller did not pass a stream
  // (the test suite passes a capture stream).
  const usePretty = destination === undefined && process.env["NODE_ENV"] !== "production";
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
      ...(usePretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, singleLine: true },
            },
          }
        : {}),
    },
    destination,
  );
}

/** Root logger — created after config load in index.ts via setRootLogger. */
export let rootLogger: pino.Logger = createLogger(process.env["LOG_LEVEL"] ?? "info");

export function setRootLogger(logger: pino.Logger): void {
  rootLogger = logger;
}
