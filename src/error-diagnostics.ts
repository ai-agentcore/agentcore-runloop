export interface ErrorDiagnostics {
  errorType: string;
  code?: string;
  status?: number;
  requestId?: string;
  causeType?: string;
  causeCode?: string;
  causeStatus?: number;
  causeRequestId?: string;
}

function safeIdentifier(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)) return fallback;
  return value;
}

function errorType(error: unknown): string {
  if (error instanceof Error) return safeIdentifier(error.name, "Error")!;
  return typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return safeIdentifier((error as { code?: unknown }).code);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode
    : (error as { status?: unknown }).status;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined;
}

function errorRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = "requestId" in error
    ? (error as { requestId?: unknown }).requestId
    : (error as { request_id?: unknown }).request_id;
  return safeIdentifier(candidate);
}

function errorCause(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("cause" in error)) return undefined;
  return (error as { cause?: unknown }).cause;
}

export function errorDiagnostics(error: unknown): ErrorDiagnostics {
  const result: ErrorDiagnostics = { errorType: errorType(error) };
  const code = errorCode(error);
  const status = errorStatus(error);
  const requestId = errorRequestId(error);
  if (code) result.code = code;
  if (status) result.status = status;
  if (requestId) result.requestId = requestId;

  const cause = errorCause(error);
  if (cause !== undefined && cause !== error) {
    result.causeType = errorType(cause);
    const causeCode = errorCode(cause);
    const causeStatus = errorStatus(cause);
    const causeRequestId = errorRequestId(cause);
    if (causeCode) result.causeCode = causeCode;
    if (causeStatus) result.causeStatus = causeStatus;
    if (causeRequestId) result.causeRequestId = causeRequestId;
  }
  return result;
}

export function errorDiagnosticsSummary(error: unknown): string {
  return Object.entries(errorDiagnostics(error)).map(([key, value]) => `${key}=${value}`).join(", ");
}

export function logSafeError(
  event: string,
  stage: string,
  error: unknown,
  detail: Record<string, string> = {},
): void {
  console.error(JSON.stringify({ event, stage, ...detail, ...errorDiagnostics(error) }));
}
