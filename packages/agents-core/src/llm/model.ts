import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  ThinkingBudgets,
  ThinkingLevel,
  ToolSchema,
} from "../protocol/index.ts";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export type { ThinkingBudgets, ThinkingLevel };

/**
 * How the model should behave for one request — the knobs that legitimately vary per agent
 * and per turn. A subset of pi's `SimpleStreamOptions`, under pi's names: connection-tier
 * settings (transport/timeouts/retries/headers) are not part of an agent's configuration
 * surface, and `deferred` returns a handle the turn loop can't stream. Anything else reaches the
 * wire through `providerOptions` if something genuinely needs it.
 *
 * One type serves both `AgentConfig.modelSettings` and `LlmRequest.params` on purpose. They
 * used to be separate look-alike shapes, and the loop forwarded only `thinking` — so a
 * `temperature` set on an agent was silently dropped. Sharing the type makes that class of
 * drift a compile error instead of a silent no-op.
 */
export type ModelSettings = Readonly<
  Pick<
    SimpleStreamOptions,
    | "temperature"
    | "maxTokens"
    | "reasoning"
    | "thinkingBudgets"
    | "toolChoice"
    | "samplingParams"
    | "cacheRetention"
    | "metadata"
  >
>;

export interface LlmRequest {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  /** Top-level tools. Tools that become available later in the conversation are declared
   *  by `system` messages in `messages` (pi's `toolsAdded`). */
  readonly tools?: readonly ToolSchema[];
  readonly params?: ModelSettings;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

/** What came back from one HTTP request. A connection failure has no `status`. */
export interface HttpExchange {
  readonly status?: number;
  /** Lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Called after every HTTP request, failed ones included, unlike pi's `onResponse`. Not called
   * for APIs that accept no custom `fetch`: Google, Vertex and Bedrock.
   */
  readonly onHttpExchange?: (exchange: HttpExchange) => void;
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
