/**
 * Error envelope (schema §4): { error: { code, message, hint? } }.
 * Routes throw ApiError (or the domain typed errors); the central handler
 * maps everything else to codes. 500s never leak internals.
 */
import { LlmHttpError, LlmTimeoutError, LlmValidationError } from "../llm/client.js";
import { LockBusyError } from "../scheduler/lock.js";
import { RunNotFoundError, RunRequestError } from "../pipeline/orchestrator.js";
import { isRetryableSheetsError, SheetsApiError } from "../sheets/client.js";

export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "RUN_LOCKED"
  | "SHEETS_FORBIDDEN"
  | "SHEETS_NOT_FOUND"
  | "SHEETS_QUOTA"
  | "LLM_UNREACHABLE"
  | "LLM_INVALID_OUTPUT"
  | "SETUP_INCOMPLETE"
  | "UNAUTHORIZED"
  | "INTERNAL";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly hint?: string | undefined;
  constructor(statusCode: number, code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export function notFound(message: string, hint?: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message, hint);
}

export function badRequest(message: string, hint?: string): ApiError {
  return new ApiError(400, "VALIDATION", message, hint);
}

export interface MappedError {
  statusCode: number;
  body: { error: { code: ErrorCode; message: string; hint?: string } };
}

export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    const body: MappedError["body"] = {
      error: { code: error.code, message: error.message },
    };
    if (error.hint !== undefined) body.error.hint = error.hint;
    return { statusCode: error.statusCode, body };
  }
  if (error instanceof RunNotFoundError) {
    return {
      statusCode: 404,
      body: { error: { code: "NOT_FOUND", message: error.message } },
    };
  }
  if (error instanceof RunRequestError) {
    return {
      statusCode: 400,
      body: { error: { code: "VALIDATION", message: error.message } },
    };
  }
  if (error instanceof LockBusyError) {    return {
      statusCode: 409,
      body: {
        error: {
          code: "RUN_LOCKED",
          message: `Pipeline is already running (run ${error.holderRunId}).`,
          hint: "Wait for it to finish, or retry that run when it completes.",
        },
      },
    };
  }
  if (error instanceof SheetsApiError) {
    if (error.errorCode === "QUOTA" || error.status === 429) {
      return {
        statusCode: 429,
        body: {
          error: {
            code: "SHEETS_QUOTA",
            message: "Google Sheets quota exceeded.",
            hint: "Wait a minute; the write queue backs off automatically.",
          },
        },
      };
    }
    if (error.errorCode === "FORBIDDEN" || error.status === 403) {
      return {
        statusCode: 403,
        body: {
          error: {
            code: "SHEETS_FORBIDDEN",
            message: "Google Sheets denied access.",
            hint: "Share the sheet with the service-account email as Editor.",
          },
        },
      };
    }
    if (
      error.errorCode === "RANGE_NOT_FOUND" ||
      error.errorCode === "SHEET_NOT_FOUND" ||
      error.status === 404
    ) {
      return {
        statusCode: 404,
        body: {
          error: {
            code: "SHEETS_NOT_FOUND",
            message: "Sheet or tab not found.",
            hint: "Run POST /api/sheets/init to create missing tabs.",
          },
        },
      };
    }
    if (isRetryableSheetsError(error)) {
      return {
        statusCode: 502,
        body: { error: { code: "INTERNAL", message: "Sheets request failed after retries." } },
      };
    }
    return {
      statusCode: 400,
      body: { error: { code: "VALIDATION", message: error.message } },
    };
  }
  if (error instanceof LlmHttpError || error instanceof LlmTimeoutError) {
    return {
      statusCode: 502,
      body: { error: { code: "LLM_UNREACHABLE", message: error.message } },
    };
  }
  if (error instanceof LlmValidationError) {
    return {
      statusCode: 502,
      body: { error: { code: "LLM_INVALID_OUTPUT", message: error.message } },
    };
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code: unknown = error.statusCode;
    if (typeof code === "number" && Number.isInteger(code)) {
      const message = error instanceof Error ? error.message : "Bad request.";
      return {
        statusCode: code,
        body: { error: { code: code === 500 ? "INTERNAL" : "VALIDATION", message } },
      };
    }
  }
  return { statusCode: 500, body: { error: { code: "INTERNAL", message: "Internal server error." } } };
}
