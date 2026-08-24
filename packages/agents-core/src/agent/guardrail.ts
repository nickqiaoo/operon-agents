import type { ToolCall, Usage } from "../protocol/index.ts";
import type {
  FinalizeToolResultHook,
  OutputGuardrailMonitor,
  OutputGuardrailMonitorOptions,
  PrepareToolExecutionHook,
} from "../loop/types.ts";
import type { ToolResult } from "../tool/types.ts";
import type { Agent, AgentRunContext } from "./agent.ts";

export interface GuardrailFunctionOutput {
  readonly tripwireTriggered: boolean;
  readonly outputInfo?: unknown;
}

export interface InputGuardrailArgs<TContext = unknown> {
  readonly agent: Agent<TContext>;
  readonly input: readonly import("../protocol/index.ts").Message[];
  readonly context: AgentRunContext<TContext>;
}

export interface InputGuardrail<TContext = unknown> {
  readonly name: string;
  execute(args: InputGuardrailArgs<TContext>): Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput;
  readonly runInParallel?: boolean;
}

export interface OutputGuardrailArgs<TContext = unknown> {
  readonly agent: Agent<TContext>;
  /** Full text produced so far (stream) or the complete final output (final). */
  readonly output: string;
  /** Text not covered by this guardrail's previous successful check. */
  readonly delta: string;
  readonly phase: "stream" | "final";
  readonly context: AgentRunContext<TContext>;
}

export interface OutputGuardrailStreamingOptions {
  /** Start a background check after this many unchecked characters. Defaults to 300. */
  readonly minChars?: number;
  /** Check an undersized tail after this delay. Defaults to 500ms. */
  readonly maxDelayMs?: number;
}

export interface OutputGuardrail<TContext = unknown> {
  readonly name: string;
  /** Opt in to optimistic delta checks. Final output is always checked. */
  readonly streaming?: boolean | OutputGuardrailStreamingOptions;
  execute(args: OutputGuardrailArgs<TContext>): Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput;
}

export type GuardrailStage = "input" | "output" | "tool_input" | "tool_output";

/** Where the tripped run lived, so an upper layer can locate (and potentially resume) it. */
export interface GuardrailLocation {
  readonly sessionId?: string;
  readonly address?: string;
  readonly agentName?: string;
  readonly turnId?: string;
  readonly step?: number;
  readonly stepId?: string;
}

export class GuardrailTripwireError extends Error {
  readonly stage: GuardrailStage;
  readonly guardrailName: string;
  readonly outputInfo?: unknown;
  readonly sessionId?: string;
  readonly address?: string;
  readonly agentName?: string;
  readonly turnId?: string;
  readonly step?: number;
  readonly stepId?: string;
  /** Model usage already incurred before an output tripwire stopped the step. */
  usage?: Usage;

  constructor(
    stage: GuardrailStage,
    guardrailName: string,
    outputInfo?: unknown,
    location?: GuardrailLocation,
  ) {
    super(`Guardrail "${guardrailName}" tripwire triggered (${stage}).`);
    this.name = "GuardrailTripwireError";
    this.stage = stage;
    this.guardrailName = guardrailName;
    this.outputInfo = outputInfo;
    this.sessionId = location?.sessionId;
    this.address = location?.address;
    this.agentName = location?.agentName;
    this.turnId = location?.turnId;
    this.step = location?.step;
    this.stepId = location?.stepId;
  }
}

export function isGuardrailTripwireError(error: unknown): error is GuardrailTripwireError {
  return error instanceof GuardrailTripwireError;
}

export async function runInputGuardrails<TContext>(
  guardrails: readonly InputGuardrail<TContext>[],
  args: InputGuardrailArgs<TContext>,
): Promise<void> {
  for (const guardrail of guardrails) {
    const output = await guardrail.execute(args);
    if (output.tripwireTriggered) throw new GuardrailTripwireError("input", guardrail.name, output.outputInfo, locationOf(args));
  }
}

export async function runOutputGuardrails<TContext>(
  guardrails: readonly OutputGuardrail<TContext>[],
  args: Omit<OutputGuardrailArgs<TContext>, "delta" | "phase"> &
    Partial<Pick<OutputGuardrailArgs<TContext>, "delta" | "phase">>,
): Promise<void> {
  const normalized: OutputGuardrailArgs<TContext> = {
    ...args,
    delta: args.delta ?? args.output,
    phase: args.phase ?? "final",
  };
  for (const guardrail of guardrails) {
    const output = await guardrail.execute(normalized);
    if (output.tripwireTriggered) throw new GuardrailTripwireError("output", guardrail.name, output.outputInfo, locationOf(normalized));
  }
}

const DEFAULT_STREAM_MIN_CHARS = 300;
const DEFAULT_STREAM_MAX_DELAY_MS = 500;

interface StreamingGuardrailState<TContext> {
  readonly guardrail: OutputGuardrail<TContext>;
  readonly minChars: number;
  readonly maxDelayMs: number;
  checkedThrough: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  runningToken?: object;
}

/** Build one per-step optimistic monitor. Deltas remain live-only and are surfaced before
 * checks complete; a tripwire aborts the model and prevents the final message from journaling. */
export function createOutputGuardrailMonitor<TContext>(
  guardrails: readonly OutputGuardrail<TContext>[],
  agent: Agent<TContext>,
  context: AgentRunContext<TContext>,
  options: OutputGuardrailMonitorOptions,
): OutputGuardrailMonitor {
  return new OptimisticOutputGuardrailMonitor(guardrails, agent, context, options);
}

class OptimisticOutputGuardrailMonitor<TContext> implements OutputGuardrailMonitor {
  readonly signal: AbortSignal;

  private readonly guardrails: readonly OutputGuardrail<TContext>[];
  private readonly streaming: StreamingGuardrailState<TContext>[];
  private readonly agent: Agent<TContext>;
  private readonly context: AgentRunContext<TContext>;
  private readonly options: OutputGuardrailMonitorOptions;
  private readonly controller?: AbortController;
  private readonly onParentAbort?: () => void;
  private output = "";
  private generation = 0;
  private failure?: unknown;
  private finishing = false;

  constructor(
    guardrails: readonly OutputGuardrail<TContext>[],
    agent: Agent<TContext>,
    context: AgentRunContext<TContext>,
    options: OutputGuardrailMonitorOptions,
  ) {
    this.guardrails = guardrails;
    this.agent = agent;
    this.context = context;
    this.options = options;
    this.streaming = guardrails.flatMap((guardrail) => {
      if (guardrail.streaming === undefined || guardrail.streaming === false) return [];
      const config = guardrail.streaming === true ? {} : guardrail.streaming;
      return [{
        guardrail,
        minChars: positiveInt(config.minChars, DEFAULT_STREAM_MIN_CHARS),
        maxDelayMs: nonNegativeInt(config.maxDelayMs, DEFAULT_STREAM_MAX_DELAY_MS),
        checkedThrough: 0,
      }];
    });

    if (this.streaming.length === 0) {
      this.signal = options.signal;
      return;
    }

    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.onParentAbort = () => this.controller?.abort(options.signal.reason);
    if (options.signal.aborted) this.onParentAbort();
    else options.signal.addEventListener("abort", this.onParentAbort, { once: true });
  }

  observeTextDelta(delta: string): void {
    if (this.finishing || this.failure !== undefined || delta.length === 0) return;
    this.output += delta;
    for (const state of this.streaming) {
      if (this.output.length - state.checkedThrough >= state.minChars) this.start(state);
      else this.ensureTimer(state);
    }
  }

  reset(): void {
    this.generation += 1;
    this.output = "";
    for (const state of this.streaming) {
      state.checkedThrough = 0;
      this.clearTimer(state);
    }
  }

  async finish(output: string, runFinal: boolean, usage: Usage): Promise<void> {
    this.finishing = true;
    this.output = output;
    try {
      for (const state of this.streaming) this.clearTimer(state);
      await this.awaitRunning();
      this.throwIfFailed();

      if (runFinal) {
        for (const guardrail of this.guardrails) {
          const state = this.streaming.find((candidate) => candidate.guardrail === guardrail);
          await this.invoke(guardrail, {
            output: this.output,
            delta: this.output.slice(state?.checkedThrough ?? 0),
            phase: "final",
          });
          if (state) state.checkedThrough = this.output.length;
        }
      } else {
        for (const state of this.streaming) {
          if (state.checkedThrough < this.output.length) this.start(state, true);
        }
        await this.awaitRunning();
      }
      this.throwIfFailed();
    } catch (error) {
      if (error instanceof GuardrailTripwireError) error.usage = usage;
      throw error;
    }
  }

  async settle(): Promise<void> {
    await this.awaitRunning();
    this.throwIfFailed();
  }

  dispose(): void {
    this.finishing = true;
    for (const state of this.streaming) this.clearTimer(state);
    if (this.onParentAbort) this.options.signal.removeEventListener("abort", this.onParentAbort);
  }

  private start(state: StreamingGuardrailState<TContext>, force = false): void {
    this.clearTimer(state);
    if (this.failure !== undefined || state.running || (this.finishing && !force)) return;
    if (!force && this.output.length - state.checkedThrough < state.minChars) {
      this.ensureTimer(state);
      return;
    }
    const snapshot = this.output;
    if (snapshot.length <= state.checkedThrough) return;
    const checkedFrom = state.checkedThrough;
    const generation = this.generation;
    const token = {};
    state.runningToken = token;
    state.running = (async () => {
      try {
        await this.invoke(state.guardrail, {
          output: snapshot,
          delta: snapshot.slice(checkedFrom),
          phase: "stream",
        });
        if (generation === this.generation) state.checkedThrough = snapshot.length;
      } catch (error) {
        if (generation === this.generation) this.fail(error);
      } finally {
        if (state.runningToken === token) {
          state.running = undefined;
          state.runningToken = undefined;
        }
        if (generation === this.generation && this.failure === undefined && !this.finishing) {
          if (this.output.length - state.checkedThrough >= state.minChars) this.start(state);
          else if (state.checkedThrough < this.output.length) this.ensureTimer(state);
        }
      }
    })();
  }

  private async invoke(
    guardrail: OutputGuardrail<TContext>,
    input: Pick<OutputGuardrailArgs<TContext>, "output" | "delta" | "phase">,
  ): Promise<void> {
    const result = await guardrail.execute({
      agent: this.agent,
      context: this.context,
      ...input,
    });
    if (result.tripwireTriggered) {
      throw new GuardrailTripwireError("output", guardrail.name, result.outputInfo, {
        sessionId: this.context.sessionId,
        address: this.context.address,
        agentName: this.agent.name,
        turnId: this.options.turnId,
        step: this.options.step,
        stepId: this.options.stepId,
      });
    }
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.controller?.abort(error);
    for (const state of this.streaming) this.clearTimer(state);
  }

  private async awaitRunning(): Promise<void> {
    while (true) {
      const running = this.streaming.flatMap((state) => state.running ? [state.running] : []);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private ensureTimer(state: StreamingGuardrailState<TContext>): void {
    if (state.timer || state.running || this.finishing || this.failure !== undefined) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.start(state, true);
    }, state.maxDelayMs);
  }

  private clearTimer(state: StreamingGuardrailState<TContext>): void {
    if (state.timer === undefined) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Extract run-locating fields from guardrail args (input/output share `agent` + `context`). */
function locationOf<TContext>(args: { agent: Agent<TContext>; context: AgentRunContext<TContext> }): GuardrailLocation {
  return { sessionId: args.context.sessionId, address: args.context.address, agentName: args.agent.name };
}

// Tool guardrails — folded into the loop's prepare/finalize hooks.

export type ToolGuardrailBehavior =
  | { readonly type: "allow" }
  | { readonly type: "rejectContent"; readonly message: string }
  | { readonly type: "throwException" };

export interface ToolGuardrailFunctionOutput {
  readonly behavior: ToolGuardrailBehavior;
  readonly outputInfo?: unknown;
}

export interface ToolInputGuardrailData<TContext = unknown> {
  readonly agent: Agent<TContext>;
  readonly toolCall: ToolCall;
  readonly context: AgentRunContext<TContext>;
}

export interface ToolOutputGuardrailData<TContext = unknown> extends ToolInputGuardrailData<TContext> {
  readonly output: ToolResult;
}

export interface ToolInputGuardrail<TContext = unknown> {
  readonly name: string;
  run(data: ToolInputGuardrailData<TContext>): Promise<ToolGuardrailFunctionOutput> | ToolGuardrailFunctionOutput;
}

export interface ToolOutputGuardrail<TContext = unknown> {
  readonly name: string;
  run(data: ToolOutputGuardrailData<TContext>): Promise<ToolGuardrailFunctionOutput> | ToolGuardrailFunctionOutput;
}

export const toolGuardrail = {
  allow(outputInfo?: unknown): ToolGuardrailFunctionOutput {
    return { behavior: { type: "allow" }, outputInfo };
  },
  rejectContent(message: string, outputInfo?: unknown): ToolGuardrailFunctionOutput {
    return { behavior: { type: "rejectContent", message }, outputInfo };
  },
  throwException(outputInfo?: unknown): ToolGuardrailFunctionOutput {
    return { behavior: { type: "throwException" }, outputInfo };
  },
};

function rejectedResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function toolInputGuardrailHook<TContext>(
  agent: Agent<TContext>,
  context: AgentRunContext<TContext>,
  guardrails: readonly ToolInputGuardrail<TContext>[],
): PrepareToolExecutionHook {
  return async (ctx) => {
    for (const guardrail of guardrails) {
      const out = await guardrail.run({ agent, toolCall: ctx.toolCall, context });
      if (out.behavior.type === "rejectContent") return { syntheticResult: rejectedResult(out.behavior.message) };
      if (out.behavior.type === "throwException")
        throw new GuardrailTripwireError("tool_input", guardrail.name, out.outputInfo, {
          sessionId: context.sessionId,
          address: context.address,
          agentName: agent.name,
        });
    }
    return undefined;
  };
}

export function toolOutputGuardrailHook<TContext>(
  agent: Agent<TContext>,
  context: AgentRunContext<TContext>,
  guardrails: readonly ToolOutputGuardrail<TContext>[],
): FinalizeToolResultHook {
  return async (ctx) => {
    let result = ctx.result;
    for (const guardrail of guardrails) {
      const out = await guardrail.run({ agent, toolCall: ctx.toolCall, output: result, context });
      if (out.behavior.type === "rejectContent") result = rejectedResult(out.behavior.message);
      else if (out.behavior.type === "throwException")
        throw new GuardrailTripwireError("tool_output", guardrail.name, out.outputInfo, {
          sessionId: context.sessionId,
          address: context.address,
          agentName: agent.name,
        });
    }
    return result;
  };
}
