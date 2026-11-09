import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "../protocol/index.ts";
import type { HttpExchange } from "./model.ts";

/** How a request that never got a response is retried. */
export interface RequestRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  /** The longest single wait. A server asking for more fails the request instead. */
  readonly maxDelayMs: number;
}

/**
 * 1s, 2s, 4s … doubling up to 5 minutes, ten retries in all. A transient failure clears within
 * the first few seconds, and six retries already span the one-minute window most token rate
 * limits use.
 */
export const DEFAULT_REQUEST_RETRY_POLICY: RequestRetryPolicy = {
  maxRetries: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

const SERVER_DELAY_MAX_JITTER_MS = 1_000;

/** The wait before retrying a failed request, or undefined when it should not be retried. */
export function requestRetryDelayMs(
  message: AssistantMessage,
  exchange: HttpExchange | undefined,
  retries: number,
  policy: RequestRetryPolicy,
): number | undefined {
  if (retries >= policy.maxRetries || !isRetryableRequestFailure(message, exchange)) return undefined;

  const serverDelayMs = exchange === undefined ? undefined : serverRequestedDelayMs(exchange);
  if (serverDelayMs !== undefined) {
    if (serverDelayMs > policy.maxDelayMs) return undefined;
    return Math.min(serverDelayMs + Math.random() * SERVER_DELAY_MAX_JITTER_MS, policy.maxDelayMs);
  }

  const backoffMs = Math.min(policy.baseDelayMs * 2 ** retries, policy.maxDelayMs);
  return Math.round(backoffMs * (1 - Math.random() * 0.25));
}

function isRetryableRequestFailure(message: AssistantMessage, exchange: HttpExchange | undefined): boolean {
  if (exchange !== undefined && exchange.status === undefined) return true; // connection failure
  const shouldRetry = exchange?.headers["x-should-retry"];
  if (shouldRetry === "true") return true;
  if (shouldRetry === "false") return false;

  const status = exchange?.status ?? bedrockFailureStatus(message);
  // Google exposes neither responses nor a status, so pi's message classifier decides there.
  if (status === undefined) return isRetryableAssistantError(message);
  // A 429 also reports exhausted quota, which waiting cannot fix. Only the body tells them apart.
  if (status === 429) return isRetryableAssistantError(message);
  return status === 408 || status === 409 || status >= 500;
}

function bedrockFailureStatus(message: AssistantMessage): number | undefined {
  const status = message.diagnostics?.find((d) => d.type === "bedrock_response_failure")?.details?.["status"];
  return typeof status === "number" ? status : undefined;
}

function serverRequestedDelayMs(exchange: HttpExchange): number | undefined {
  return retryAfterMs(exchange.headers) ?? (exchange.status === 429 ? rateLimitResetMs(exchange.headers) : undefined);
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const millis = positive(Number.parseFloat(headers["retry-after-ms"] ?? ""));
  if (millis !== undefined) return millis;
  const value = headers["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return positive(Number.isNaN(seconds) ? Date.parse(value) - Date.now() : seconds * 1_000);
}

const RATE_LIMIT_RESET_HEADER = /^(?:x-ratelimit-reset-(?<openai>.+)|anthropic-ratelimit-(?<anthropic>.+)-reset)$/;

/** When the exhausted limits reset. A limit with budget left is not what rejected the request. */
function rateLimitResetMs(headers: Readonly<Record<string, string>>): number | undefined {
  let latest: number | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const groups = RATE_LIMIT_RESET_HEADER.exec(name)?.groups;
    if (groups === undefined) continue;
    const remaining = groups["openai"] !== undefined
      ? headers[`x-ratelimit-remaining-${groups["openai"]}`]
      : headers[`anthropic-ratelimit-${groups["anthropic"]}-remaining`];
    if (remaining !== "0") continue;
    const resetMs = groups["openai"] !== undefined ? durationMs(value) : positive(Date.parse(value) - Date.now());
    if (resetMs !== undefined && (latest === undefined || resetMs > latest)) latest = resetMs;
  }
  return latest;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

/** OpenAI's reset format: `37s`, `6m0s`, `1h2m3.5s`, `250ms`. */
function durationMs(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(value)) return undefined;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(amount) * DURATION_UNIT_MS[unit!]!;
  }
  return positive(total);
}

function positive(ms: number): number | undefined {
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
