import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  ThinkingBudgets,
  ThinkingLevel,
  ToolSchema,
} from "../protocol/index.ts";

export type { ThinkingBudgets, ThinkingLevel };

export type RetryHint = { readonly retryable: boolean; readonly afterMs?: number };

/**
 * How the model should behave for one request — the knobs that legitimately vary per agent
 * and per turn. Deliberately NOT pi's `SimpleStreamOptions`: connection-tier settings
 * (transport/timeouts/retries/headers) are not part of an agent's configuration surface, and
 * reach the wire through `providerOptions` if something genuinely needs them.
 *
 * One type serves both `AgentConfig.modelSettings` and `LlmRequest.params` on purpose. They
 * used to be separate look-alike shapes, and the loop forwarded only `thinking` — so a
 * `temperature` set on an agent was silently dropped. Sharing the type makes that class of
 * drift a compile error instead of a silent no-op.
 */
export interface ModelSettings {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: ThinkingLevel;
  /**
   * Per-level thinking budgets, for models that take a token budget rather than an effort
   * level. Adaptive-thinking models ignore it. Only consulted when `thinking` is set.
   */
  readonly thinkingBudgets?: ThinkingBudgets;
}

export interface LlmRequest {
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly params?: ModelSettings;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface StreamResultOptions {
  readonly onEvent?: (event: AssistantMessageEvent) => void;
}

export async function streamResult(
  stream: AssistantMessageEventStream,
  options: StreamResultOptions = {},
): Promise<AssistantMessage> {
  if (options.onEvent !== undefined) {
    for await (const event of stream) {
      options.onEvent(event);
    }
  }
  return stream.result();
}
