/** Composio integration error codes (docs/15 §6). Never carries the API key. */
export const COMPOSIO_CODES = [
  "COMPOSIO_NOT_CONFIGURED",
  "COMPOSIO_NOT_CONNECTED",
  "COMPOSIO_AUTH_EXPIRED",
  "COMPOSIO_TOOL_MISSING",
  "COMPOSIO_TOOL_ERROR",
  "COMPOSIO_BUDGET_EXCEEDED",
  "SHEETS_QUOTA",
  "SHEET_ID_INVALID",
] as const;

export type ComposioCode = (typeof COMPOSIO_CODES)[number];

export class ComposioError extends Error {
  readonly code: ComposioCode;

  constructor(code: ComposioCode, message: string) {
    super(message);
    this.name = "ComposioError";
    this.code = code;
  }
}
