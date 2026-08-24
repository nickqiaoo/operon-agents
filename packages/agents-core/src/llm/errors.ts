import type { RetryHint } from "./model.ts";

export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatProviderError";
  }
}

export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = "APIConnectionError";
  }
}

export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = "APITimeoutError";
  }
}

export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;

  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(message);
    this.name = "APIStatusError";
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
  }
}

export class APIContextOverflowError extends APIStatusError {
  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(statusCode, message, requestId);
    this.name = "APIContextOverflowError";
  }
}

export class APIEmptyResponseError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = "APIEmptyResponseError";
  }
}

const RETRYABLE_STATUS_CODES: readonly number[] = [429, 500, 502, 503, 504];

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    return RETRYABLE_STATUS_CODES.includes(error.statusCode);
  }
  const status = extractStatusCode(error);
  return status !== undefined && RETRYABLE_STATUS_CODES.includes(status);
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS: readonly RegExp[] = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
];

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === "context_length_exceeded";
}

/**
 * Message-text-only overflow detection, for the paths where the transport has already reduced
 * the error to a string (model adapters fold thrown errors into `stopReason: "error"` messages,
 * so class and status code are gone by the time the loop sees them).
 */
export function isContextOverflowMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  return isContextOverflowMessage(message);
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
): APIStatusError {
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId);
  }
  return new APIStatusError(statusCode, message, requestId);
}

export function classifyError(error: unknown): RetryHint {
  if (error instanceof APIContextOverflowError) {
    return { retryable: false };
  }
  const status = extractStatusCode(error);
  const message = extractMessage(error);
  if (status !== undefined && isContextOverflowStatusError(status, message)) {
    return { retryable: false };
  }
  // No status to gate on (the string path): classify overflow from the message alone, so the
  // retry layer gives up immediately instead of falling through the generic-retryable check.
  if (status === undefined && isContextOverflowMessage(message)) {
    return { retryable: false };
  }
  if (isRetryableGenerateError(error)) {
    const afterMs = parseRetryAfterMs(error);
    return afterMs === undefined ? { retryable: true } : { retryable: true, afterMs };
  }
  return { retryable: false };
}

// Generic error-shape extraction (interface adapter for non-class errors).

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const candidate = record["statusCode"] ?? record["status"];
  return typeof candidate === "number" ? candidate : undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function parseRetryAfterMs(error: unknown): number | undefined {
  const raw = extractRetryAfter(error);
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function extractRetryAfter(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  const headers = record["headers"];
  if (headers instanceof Headers) {
    return headers.get("retry-after") ?? undefined;
  }
  if (typeof headers === "object" && headers !== null) {
    const bag = headers as Record<string, unknown>;
    const value = bag["retry-after"] ?? bag["Retry-After"];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }

  const top = record["retryAfter"];
  if (typeof top === "string" || typeof top === "number") return String(top);
  return undefined;
}
