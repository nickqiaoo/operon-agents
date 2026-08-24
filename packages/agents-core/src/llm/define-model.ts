import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Context,
  ModelsSimpleStreamOptions,
  TSchema,
} from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, PiTool, Provider, ProviderHeaders, ToolSchema, Transport } from "../protocol/index.ts";
import { emptyUsage } from "../loop/usage.ts";
import {
  createModelRuntime,
  forceRefreshOAuth,
  type ModelRuntime,
} from "./runtime.ts";
import { classifyError } from "./errors.ts";
import type { CallOptions, LlmRequest, RetryHint } from "./model.ts";

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
 * The config-file path (`ProviderConfigSchema` → `ProviderManager`) reaches the same wire
 * settings through provider and model descriptor headers; this is the programmatic equivalent
 * for callers building a `ChatModel` directly.
 */
export interface ModelConnection {
  /** Merged over provider and model defaults. A `null` value deletes a header pi would send. */
  readonly headers?: ProviderHeaders;
  /** HTTP request timeout, for providers/SDKs that support it. */
  readonly timeoutMs?: number;
  /**
   * Retries INSIDE the provider call, below `streamWithRetry`. Leave unset: pi defaults it to
   * 0 and the loop's own retry is the one with the context to decide (it can tell a
   * mid-stream failure from a clean one and fall back to non-streaming). Setting it here
   * multiplies with that — 3 loop attempts × N here.
   */
  readonly maxRetries?: number;
  /** Cap on honoring a server-requested retry delay. pi defaults to 60s; 0 disables the cap. */
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

interface ModelSpecBase {
  readonly runtime?: ModelRuntime;
  /** Transport-tier settings applied to every request this model makes. */
  readonly connection?: ModelConnection;
  /**
   * Credential for this model, for the common case of holding a key in code or config rather
   * than in a `CredentialStore`.
   *
   * This OVERRIDES whatever the runtime's credential store resolves for the provider,
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

export type ModelSpec =
  | (ModelSpecBase & {
      readonly provider: string;
      readonly model: string;
      readonly baseUrl?: string;
    })
  | (ModelSpecBase & {
      readonly descriptor: Model<Api>;
      /** A descriptor needs the Models collection that owns its provider. */
      readonly runtime: ModelRuntime;
    });

export class ChatModel {
  readonly id: string;
  readonly provider: Provider;
  readonly api: Api;
  readonly contextWindow: number;
  /** Upper bound on tokens this model can emit in one response. Compaction sizes the room it
   *  holds back for the summary against this — a model that cannot emit 20k never needs 20k
   *  reserved. */
  readonly maxOutputTokens: number;
  readonly supportsDeferredTools: boolean;
  private readonly piModel: Model<Api>;
  private readonly runtime: ModelRuntime;
  /** Build-time settings (`apiKey` + `connection`) flattened once into pi's option shape.
   *  Every request starts from these; `params` and `providerOptions` layer on top. */
  private readonly requestDefaults: Omit<ModelsSimpleStreamOptions, "signal">;

  constructor(spec: ModelSpec) {
    this.runtime = spec.runtime ?? createModelRuntime();
    this.piModel = resolvePiModel(spec, this.runtime);
    this.requestDefaults = {
      ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
      ...spec.connection,
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
      first = await this.runtime.models.completeSimple(
        this.piModel,
        ctx,
        toOptions(req, call, this.requestDefaults),
      );
    } catch (error) {
      first = this.errorMessage(messageOf(error));
    }
    if (first.stopReason !== "error" || !isAuthError(first.errorMessage ?? "")) {
      return first;
    }
    try {
      if (!(await forceRefreshOAuth(this.runtime, this.provider, call?.signal))) return first;
      return await this.runtime.models.completeSimple(
        this.piModel,
        ctx,
        toOptions(req, call, this.requestDefaults),
      );
    } catch (error) {
      return this.errorMessage(messageOf(error));
    }
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
        if (!(await forceRefreshOAuth(this.runtime, this.provider, call?.signal))) {
          out.push(first.terminal);
          return;
        }
      } catch (error) {
        out.push(this.errorEvent(messageOf(error)));
        return;
      }
      const second = await this.runAttempt(req, call, ctx, out);
      if (!second.resolved) out.push(second.terminal); // retry also failed → machine
      return;
    }
    out.push(first.terminal); // not a refreshable auth error → machine
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
      for await (const event of this.runtime.models.streamSimple(
        this.piModel,
        ctx,
        toOptions(req, call, this.requestDefaults),
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
      out.push(terminal); // success, or a mid-stream error we must not retry → machine
      return { resolved: true };
    }
    return { resolved: false, errorMessage, terminal };
  }

  classifyError(err: unknown): RetryHint {
    return classifyError(err);
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

function resolvePiModel(spec: ModelSpec, runtime: ModelRuntime): Model<Api> {
  if ("descriptor" in spec) return spec.descriptor;
  const model = tryGetPiModel(spec.provider, spec.model, runtime);
  if (!model) throw new Error(`unknown model: ${spec.provider}/${spec.model}`);
  return spec.baseUrl ? { ...model, baseUrl: spec.baseUrl } : model;
}

export function tryGetPiModel(
  provider: string,
  model: string,
  runtime: ModelRuntime = createModelRuntime(),
): Model<Api> | undefined {
  return runtime.models.getModel(provider, model);
}

/**
 * Mirror pi's public model-compat gates so Operon only hides capability tools
 * when the selected wire can materialize `addedToolNames`. pi remains the
 * authority for serialization; this gate only decides whether SearchTool mode
 * is safe to enter.
 */
function supportsNativeDeferredTools(model: Model<Api>): boolean {
  const compat = model.compat as
    | {
        readonly supportsToolReferences?: boolean;
        readonly deferredToolsMode?: "kimi";
        readonly supportsToolSearch?: boolean;
      }
    | undefined;

  if (model.api === "openai-completions") return compat?.deferredToolsMode === "kimi";
  if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
    return compat?.supportsToolSearch === true;
  }
  if (model.api !== "anthropic-messages") return false;
  if (compat?.supportsToolReferences !== undefined) return compat.supportsToolReferences;

  // pi's Anthropic default: first-party Claude >= 4.5, excluding Haiku.
  if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
  const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

function toContext(req: LlmRequest): Context {
  return {
    systemPrompt: req.system,
    messages: [...req.messages],
    tools: req.tools?.map(toPiTool),
  };
}

function toPiTool(tool: ToolSchema): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // protocol-level params are a JSON Schema object; pi serializes it as the tool schema.
    parameters: tool.parameters as unknown as TSchema,
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
    ...(req.params?.thinking !== undefined
      ? { reasoning: req.params.thinking }
      : {}),
    // Only meaningful alongside `reasoning`: pi reads it from `adjustMaxTokensForThinking`,
    // which `streamSimple` skips entirely when no reasoning level was requested.
    ...(req.params?.thinkingBudgets !== undefined
      ? { thinkingBudgets: req.params.thinkingBudgets }
      : {}),
    ...(req.params?.temperature !== undefined
      ? { temperature: req.params.temperature }
      : {}),
    ...(req.params?.maxTokens !== undefined
      ? { maxTokens: req.params.maxTokens }
      : {}),
    ...(call?.signal !== undefined ? { signal: call.signal } : {}),
    ...req.providerOptions,
  };
}
