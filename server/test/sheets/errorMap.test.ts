import { describe, expect, it } from "vitest";
import { SheetsApiError, isMissingRangeError, isRetryableSheetsError } from "../../src/sheets/client.js";
import { mapSheetsHttpError } from "../../src/sheets/realClient.js";

describe("SheetsApiError helpers", () => {
  it("429 and 5xx are retryable; 403/400 are not", () => {
    expect(isRetryableSheetsError(new SheetsApiError("q", { status: 429 }))).toBe(true);
    expect(isRetryableSheetsError(new SheetsApiError("s", { status: 503 }))).toBe(true);
    expect(isRetryableSheetsError(new SheetsApiError("f", { status: 403 }))).toBe(false);
    expect(isRetryableSheetsError(new SheetsApiError("b", { status: 400 }))).toBe(false);
    expect(isRetryableSheetsError(new Error("plain"))).toBe(false);
  });

  it("detects missing-range errors by code or message", () => {
    expect(isMissingRangeError(new SheetsApiError("x", { status: 400, errorCode: "RANGE_NOT_FOUND" }))).toBe(
      true,
    );
    // A bare message without HTTP context is not enough — status is required.
    expect(isMissingRangeError(new SheetsApiError("Unable to parse range: 'raw_trends'!A1"))).toBe(false);
    expect(
      isMissingRangeError(
        new SheetsApiError("Unable to parse range: 'raw_trends'!A1", { status: 400 }),
      ),
    ).toBe(true);
  });
});

describe("mapSheetsHttpError", () => {
  it("maps a 429 with Retry-After", () => {
    const err = mapSheetsHttpError({
      message: "Quota exceeded",
      response: { status: 429, headers: { "retry-after": "7" } },
    });
    expect(err).toBeInstanceOf(SheetsApiError);
    expect(err.status).toBe(429);
    expect(err.errorCode).toBe("QUOTA");
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("maps 403 to FORBIDDEN", () => {
    const err = mapSheetsHttpError({ message: "Denied", response: { status: 403, headers: {} } });
    expect(err.status).toBe(403);
    expect(err.errorCode).toBe("FORBIDDEN");
  });

  it("maps 400 range errors to RANGE_NOT_FOUND", () => {
    const err = mapSheetsHttpError({
      message: "Unable to parse range: 'raw_trends'!A:ZZZ",
      response: { status: 400, headers: {} },
    });
    expect(err.errorCode).toBe("RANGE_NOT_FOUND");
  });

  it("maps 5xx without a code", () => {
    const err = mapSheetsHttpError({ message: "Backend error", response: { status: 500, headers: {} } });
    expect(err.status).toBe(500);
    expect(err.errorCode).toBeUndefined();
  });

  it("passes SheetsApiError through untouched", () => {
    const original = new SheetsApiError("orig", { status: 429 });
    expect(mapSheetsHttpError(original)).toBe(original);
  });

  it("wraps unknown shapes with the original message", () => {
    const err = mapSheetsHttpError(new TypeError("fetch failed"));
    expect(err).toBeInstanceOf(SheetsApiError);
    expect(err.status).toBeUndefined();
    expect(err.message).toContain("fetch failed");
  });
});
