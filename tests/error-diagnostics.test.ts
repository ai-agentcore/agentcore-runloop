import { afterEach, describe, expect, it, vi } from "vitest";
import { errorDiagnostics, errorDiagnosticsSummary, logSafeError } from "../src/error-diagnostics.js";

afterEach(() => vi.restoreAllMocks());

describe("safe error diagnostics", () => {
  it("keeps allowlisted SDK identity fields and omits exception messages", () => {
    const error = Object.assign(new Error("credential and upstream body"), {
      code: "Forbidden.NoPermission", statusCode: 403, requestId: "request-1",
    });
    expect(errorDiagnostics(error)).toEqual({
      errorType: "Error", code: "Forbidden.NoPermission", status: 403, requestId: "request-1",
    });
    expect(errorDiagnosticsSummary(error)).toBe(
      "errorType=Error, code=Forbidden.NoPermission, status=403, requestId=request-1",
    );
    expect(JSON.stringify(errorDiagnostics(error))).not.toContain(error.message);
  });

  it("reports a sanitized nested cause and drops malformed fields", () => {
    const cause = Object.assign(new Error("hidden"), {
      code: "ResourceNotFound", status: 404, request_id: "upstream/request-2",
    });
    expect(errorDiagnostics(Object.assign(new Error("wrapper"), {
      name: "RuntimeInitializationError", cause,
    }))).toEqual({
      errorType: "RuntimeInitializationError", causeType: "Error", causeCode: "ResourceNotFound",
      causeStatus: 404, causeRequestId: "upstream/request-2",
    });
    const malformed = Object.assign(new Error("hidden"), {
      name: "bad type with spaces", code: "bad code with spaces", statusCode: 999, requestId: "bad id with spaces",
    });
    malformed.cause = malformed;
    expect(errorDiagnostics(malformed)).toEqual({ errorType: "Error" });
  });

  it("writes one structured log record without the raw message", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    logSafeError("resource_failed", "mcp", Object.assign(new Error("do-not-log"), {
      code: "Denied", status: 403,
    }), { resource: "repo" });
    const line = String(output.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      event: "resource_failed", stage: "mcp", resource: "repo", errorType: "Error", code: "Denied", status: 403,
    });
    expect(line).not.toContain("do-not-log");
  });
});
