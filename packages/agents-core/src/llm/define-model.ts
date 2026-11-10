import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, PiTool, Provider, ProviderHeaders, ToolSchema, Transport } from "../protocol/index.ts";
import { emptyUsage } from "../loop/usage.ts";
import {
  forceRefreshOAuth,
  type ModelManager,
} from "./model-manager.ts";
import type { CallOptions, HttpExchange, LlmRequest } from "./model.ts";
import { DEFAULT_REQUEST_RETRY_POLICY, type RequestRetryPolicy } from "./request-retry.ts";

/** Node's longest timer, which is what "no cap" on a retry wait amounts to. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** pi's adapters that send through `options.fetch`; the Google ones reject it outright. */
const APIS_WITH_CUSTOM_FETCH: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);

/** A finished attempt: either resolved (terminal already pushed to the out stream) or a
 *  clean pre-content failure the caller may retry. */
type Attempt = { readonly resolved: true } | { readonly resolved: false; readonly errorMessage: string; readonly terminal: AssistantMessageEvent };

/**
 * How to reach the endpoint, as opposed to how the model should think. Fixed when the model is
 * built, applied to every request it makes.
 *
 * The split from `ModelSettings` is the point: these describe the transport and never vary by
 * agent or by turn, so keeping them here leaves `ModelSettings` free of knobs nobody wants to
 * tune per call. `LlmRequest.providerOptions` still overrides any of them for a single request.
 *
 * Named fields rather than pi's whole `SimpleStreamOptions`: a bag of that shape used to sit on
 * `ModelSpec`, which let `temperature` be configured both here and on an agent with only a
 * silent precedence rule between them. Anything absent from this interface is deliberate — add
 * a field when a knob earns one, instead of reopening the bag.
 *
 * Set it for a whole provider with `ModelManager.register`, for one model with
 * `ModelManager.resolve`, or on a `ChatModel` built directly.
 */
export interface ModelConnection {
  /** Merged over provider and model defaults. A `null` value deletes a header pi would send. */
  readonly headers?: ProviderHeaders;
  /** HTTP request timeout, for providers/SDKs that support it. */
  readonly timeoutMs?: number;
  /**
   * Retries of a request that failed before its response started: 429, 408, 409, 5xx and
   * connection failures. Exponential backoff, honoring `Retry-After` and rate-limit reset
   * headers. Defaults to 10; 0 turns them off. pi's own retries are always off, so
   * `streamWithRetry` can report each wait.
   */
  readonly maxRetries?: number;
  /**
   * The longest single retry wait. Defaults to 5 minutes; 0 removes the cap. A server asking for
   * longer fails the request at once.
   */
  readonly maxRetryDelayMs?: number;
  /**
   * Wire transport. Today only `openai-codex-responses` (the ChatGPT-subscription backend)
   * reads it; every other API ignores it.
   *
   * The default `"auto"` is already the best setting there: a per-session pooled WebSocket
   * that sends only the turn's NEW items, continuing from the connection-scoped
   * `previous_response_id` instead of re-uploading the whole history each round. It falls
   * back to SSE on its own if the socket fails before any content is emitted (after content,
   * it errors rather than replaying), and remembers the fallback for the rest of the session.
   *
   * So the real reason to set this is diagnostic: pin `"sse"` to take the pooling, delta
   * continuation, and sticky-fallback machinery out of the picture when investigating a
   * suspected transport problem.
   */
  readonly transport?: Transport;
  /** WebSocket connect/open handshake budget; stream idleness still uses `timeoutMs`. */
  readonly websocketConnectTimeoutMs?: number;
}

export interface ModelSpec {
  /** Owns the provider `descriptor` belongs to; every request goes through it. */
  readonly manager: ModelManager;
  readonly descriptor: Model<Api>;
  /** Transport-tier settings applied to every request this model makes. */
  readonly connection?: ModelConnection;
  /**
   * Credential for this model, for the common case of holding a key in code or config rather
   * than in a `CredentialStore`.
   *
   * This OVERRIDES whatever the manager's credential store resolves for the provider,
   * including a freshly refreshed OAuth token — passing it opts out of `forceRefreshOAuth`
   * recovery for this model. Leave it unset to use ambient credentials (`ANTHROPIC_API_KEY`
   * and friends) or a stored credential, which is what OAuth-based providers want.
   *
   * Scope note: pi models auth per PROVIDER, one credential per provider id. This field is
   * per model, so two `ChatModel`s on the same provider can legitimately carry different
   * keys — useful, but it means this is not a way to configure the provider itself.
   */
  readonly apiKey?: string;
}


export class ChatModel {
  readonly id: string;
  readonly provider: Provider;
  readonly api: Api;
  readonly contextWindow: number;
  /** Upper bound on tokens this model can emit in one response. Compaction sizes the room it
   *  holds back for the summary against this — a model that cannot emit 20k never needs 20k
   *  reserved. */
  readonly maxOutputTokens: number;
  /** Loading a deferred tool mid-conversation keeps the request prefix: SearchTool mode. */
  readonly supportsDeferredTools: boolean;
  private readonly piModel: Model<Api>;
  private readonly manager: ModelManager;
  /** Build-time settings (`apiKey` + `connection`) flattened once into pi's option shape.
   *  Every request starts from these; `params` and `providerOptions` layer on top. */
  private readonly requestDefaults: Omit<ModelsSimpleStreamOptions, "signal">;
  /** Read by `streamWithRetry` and `completeWithRetry`, which own every retry. */
  readonly requestRetry: RequestRetryPolicy;

  constructor(spec: ModelSpec) {
    this.manager = spec.manager;
    this.piModel = withAnthropicToolChanges(spec.descriptor);
    const { maxRetries, maxRetryDelayMs, ...transport } = spec.connection ?? {};
    this.requestRetry = {
      ...DEFAULT_REQUEST_RETRY_POLICY,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(maxRetryDelayMs !== undefined ? { maxDelayMs: maxRetryDelayMs === 0 ? MAX_TIMER_MS : maxRetryDelayMs } : {}),
    };
    this.requestDefaults = {
      ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
      ...transport,
      maxRetries: 0,
    };
    this.id = this.piModel.id;
    this.provider = this.piModel.provider;
    this.api = this.piModel.api;
    this.contextWindow = this.piModel.contextWindow;
    this.maxOutputTokens = this.piModel.maxTokens;
    this.supportsDeferredTools = supportsNativeDeferredTools(this.piModel);
  }

  stream(req: LlmRequest, call?: CallOptions): AssistantMessageEventStream {
    const ctx = toContext(req);
    // Models performs provider lookup, auth resolution, OAuth expiry refresh,
    // credential-specific baseUrl/headers, and lazy API dispatch.
    const out = createAssistantMessageEventStream();
    void this.streamWithAuthRetry(req, call, ctx, out);
    return out;
  }

  async complete(req: LlmRequest, call?: CallOptions): Promise<AssistantMessage> {
    const ctx = toContext(req);
    let first: AssistantMessage;
    try {
      first = await this.manager.models.completeSimple(
        this.piModel,
        ctx,
        this.options(req, call),
      );
    } catch (error) {
      first = this.errorMessage(messageOf(error));
    }
    if (first.stopReason !== "error" || !isAuthError(first.errorMessage ?? "")) {
      return first;
    }
    try {
      if (!(await forceRefreshOAuth(this.manager, this.provider, call?.signal))) return first;
      return await this.manager.models.completeSimple(
        this.piModel,
        ctx,
        this.options(req, call),
      );
    } catch (error) {
      return this.errorMessage(messageOf(error));
    }
  }

  private options(req: LlmRequest, call?: CallOptions): ModelsSimpleStreamOptions {
    const options = toOptions(req, call, this.requestDefaults);
    if (call?.onHttpExchange === undefined || !APIS_WITH_CUSTOM_FETCH.has(this.api)) return options;
    return { ...options, fetch: observingFetch(options.fetch, call.onHttpExchange) };
  }

  private async streamWithAuthRetry(
    req: LlmRequest,
    call: CallOptions | undefined,
    ctx: Context,
    out: AssistantMessageEventStream,
  ): Promise<void> {
    const first = await this.runAttempt(req, call, ctx, out);
    if (first.resolved) return;

    // pi refreshes expired OAuth credentials. Preserve Operon's additional
    // revoked-token recovery: one forced refresh after a clean pre-content 401.
    if (isAuthError(first.errorMessage)) {
      try {
        if (!(await forceRefreshOAuth(this.manager, this.provider, call?.signal))) {
          out.push(first.terminal);
          return;
        }
      } catch (error) {
        out.push(this.errorEvent(messageOf(error)));
        return;
      }
      const second = await this.runAttempt(req, call, ctx, out);
      if (!second.resolved) out.push(second.terminal); // retry also failed → environment
      return;
    }
    out.push(first.terminal); // not a refreshable auth error → environment
  }

  /** Stream one attempt. Non-terminal events are relayed live; the terminal event is held so
   *  a clean pre-content failure can be retried instead of surfaced. */
  private async runAttempt(
    req: LlmRequest,
    call: CallOptions | undefined,
    ctx: Context,
    out: AssistantMessageEventStream,
  ): Promise<Attempt> {
    let streamedContent = false;
    let terminal: AssistantMessageEvent | undefined;
    try {
      for await (const event of this.manager.models.streamSimple(
        this.piModel,
        ctx,
        this.options(req, call),
      )) {
        if (event.type === "done" || event.type === "error") {
          terminal = event;
          break;
        }
        out.push(event);
        if (isContentEvent(event)) streamedContent = true;
      }
    } catch (error) {
      terminal = this.errorEvent(messageOf(error));
    }
    if (terminal === undefined) return { resolved: true }; // (pi always emits a terminal)
    const errorMessage = terminalErrorMessage(terminal);
    if (errorMessage === undefined || streamedContent) {
      out.push(terminal); // success, or a mid-stream error we must not retry → environment
      return { resolved: true };
    }
    return { resolved: false, errorMessage, terminal };
  }

  private errorEvent(text: string): AssistantMessageEvent {
    return { type: "error", reason: "error", error: this.errorMessage(text) };
  }

  private errorMessage(text: string): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: this.api,
      provider: this.provider,
      model: this.id,
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: text,
      timestamp: Date.now(),
    };
  }
}

/** Reports each exchange and changes nothing about it. */
function observingFetch(
  inner: typeof globalThis.fetch | undefined,
  observe: (exchange: HttpExchange) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await (inner ?? globalThis.fetch)(input, init);
    } catch (error) {
      observe({ headers: {} });
      throw error;
    }
    observe({ status: response.status, headers: Object.fromEntries(response.headers) });
    return response;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error message of a terminal event, or undefined if it represents success.
 *  pi reports failures either as an `error` event or a `done` whose message stopped on error. */
function terminalErrorMessage(event: AssistantMessageEvent): string | undefined {
  if (event.type === "error") return event.error.errorMessage ?? "stream error";
  if (event.type === "done" && event.message.stopReason === "error") return event.message.errorMessage ?? "stream error";
  return undefined;
}

/** Whether an event carries real model output — so a forced auth retry never duplicates
 *  streamed content. Empty start/end scaffolding does not count. */
function isContentEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

const AUTH_ERROR_PATTERN =
  /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication\s+(?:failed|error)|invalid[\s_-]?(?:token|credential)|token\s+(?:expired|revoked)/i;

/** Heuristic: does this provider error look like an auth failure worth a forced token refresh? */
function isAuthError(message: string): boolean {
  return AUTH_ERROR_PATTERN.test(message);
}

export function defineModel(spec: ModelSpec): ChatModel {
  return new ChatModel(spec);
}

/**
 * Mirror pi's gates for anchoring a `toolsAdded` system message in place, so Operon only
 * hides capability tools when loading one will not rewrite the request prefix. Everywhere
 * else pi collapses later system messages into the leading one — the whole current tool list
 * at the top — which is exactly the per-load prefix rewrite deferral must not cause.
 */
function supportsNativeDeferredTools(model: Model<Api>): boolean {
  const compat = model.compat as
    | {
        readonly supportsMidConvoSystemMessages?: boolean;
        readonly supportsMidConvoToolChanges?: boolean;
        readonly supportsMidConvoToolAdditions?: boolean;
        readonly supportsAdditionalTools?: boolean;
        readonly supportsToolSearch?: boolean;
      }
    | undefined;
  if (compat?.supportsMidConvoSystemMessages !== true) return false;
  switch (model.api) {
    case "anthropic-messages":
      return compat.supportsMidConvoToolChanges === true;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return compat.supportsAdditionalTools === true || compat.supportsToolSearch === true;
    case "openai-completions":
      return compat.supportsMidConvoToolAdditions === true;
    default:
      return false;
  }
}

/**
 * pi's catalog flags mid-conversation `tool_addition` support only on direct Anthropic models,
 * though the same model takes them through a gateway or proxy on the Anthropic wire (Sonnet 5.5
 * verified through OpenRouter). Carry that flag over to the models it leaves unset. An explicit
 * flag always wins.
 */
function withAnthropicToolChanges(model: Model<Api>): Model<Api> {
  if (model.api !== "anthropic-messages") return model;
  const compat = model.compat as
    | { readonly supportsMidConvoSystemMessages?: boolean; readonly supportsMidConvoToolChanges?: boolean }
    | undefined;
  if (compat?.supportsMidConvoToolChanges !== undefined || !acceptsMidConvoToolChanges(model.id)) return model;
  return {
    ...model,
    compat: {
      ...compat,
      supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? true,
      supportsMidConvoToolChanges: true,
    },
  } as Model<Api>;
}

/**
 * Whether pi's direct Anthropic catalog flags this model, however the id is spelled:
 * `claude-opus-4-8`, `anthropic/claude-sonnet-5.5`, `claude-fable-5-20260101`, ...
 */
export function acceptsMidConvoToolChanges(modelId: string): boolean {
  const directId = modelId.replace(/^.*\//, "").replace(/\./g, "-").replace(/-\d{8}$/, "");
  const direct = (ANTHROPIC_MODELS as Readonly<Record<string, Model<Api> | undefined>>)[directId];
  return (direct?.compat as { readonly supportsMidConvoToolChanges?: boolean } | undefined)?.supportsMidConvoToolChanges === true;
}

function toContext(req: LlmRequest): Context {
  return {
    systemPrompt: req.systemPrompt,
    messages: [...req.messages],
    tools: req.tools?.map(toPiTool),
  };
}

function toPiTool(tool: ToolSchema): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // protocol-level params are a JSON Schema object; pi serializes it as the tool schema.
    parameters: tool.parameters as unknown as PiTool["parameters"],
  };
}

/**
 * Map our request onto pi's simple stream options. Ordering IS the precedence rule, lowest
 * first: the model's build-time defaults (`apiKey` + `connection`), then `params` (agent
 * profile + session runtime, already folded by `resolveModelParams`), then the caller's
 * signal, and `providerOptions` last so the extension escape hatch overrides anything above it.
 *
 * The two lower tiers do not overlap by construction — `ModelConnection` is transport, `params`
 * is inference — so the order between them only matters if pi ever merges the two vocabularies.
 */
function toOptions(
  req: LlmRequest,
  call: CallOptions | undefined,
  defaults: Omit<ModelsSimpleStreamOptions, "signal">,
): ModelsSimpleStreamOptions {
  return {
    ...defaults,
    ...req.params,
    ...(call?.signal !== undefined ? { signal: call.signal } : {}),
    ...req.providerOptions,
  };
}
