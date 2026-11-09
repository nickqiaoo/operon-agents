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
