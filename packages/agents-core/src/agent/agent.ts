import type { ChatModel } from "../llm/define-model.ts";
import type { ModelSettings } from "../llm/model.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { Handoff } from "./handoff.ts";
import type { InputGuardrail, OutputGuardrail, ToolInputGuardrail, ToolOutputGuardrail } from "./guardrail.ts";
import type { SystemPromptContext } from "./instruction-context.ts";

export interface AgentRunContext<TContext = unknown> {
  readonly sessionId: string;
  readonly address: string;
  readonly signal: AbortSignal;
  readonly context?: TContext;
  /** Machine of the current runtime frame (root/subagent/worktree), never captured by Agent. */
  readonly machine?: Machine;
  /** Lazily resolves Session-cached environment + AGENTS.md data for this runtime frame. */
  readonly resolveSystemPromptContext?: () => Promise<SystemPromptContext>;
}

export interface AgentGuardrails<TContext = unknown> {
  readonly input?: readonly InputGuardrail<TContext>[];
  readonly output?: readonly OutputGuardrail<TContext>[];
  readonly toolInput?: readonly ToolInputGuardrail<TContext>[];
  readonly toolOutput?: readonly ToolOutputGuardrail<TContext>[];
}

export interface AgentConfig<TContext = unknown> {
  readonly name: string;
  readonly instructions?: string | ((ctx: AgentRunContext<TContext>) => string | Promise<string>);
  readonly handoffDescription?: string;
  readonly model?: string | ChatModel;
  /**
   * Static per-request model behavior for this agent. Session-level runtime overrides
   * (`setThinkingLevel()`) win over what is set here — see `resolveModelParams`.
   */
  readonly modelSettings?: ModelSettings;
  readonly tools?: readonly Tool[];
  readonly handoffs?: readonly Handoff<TContext>[];
  readonly subagents?: readonly Agent<TContext>[];
  readonly guardrails?: AgentGuardrails<TContext>;
  readonly outputType?: unknown;
  readonly maxStepsPerTurn?: number;
  /**
   * Opt into deferred tool loading: capability/MCP tools are discovered on
   * demand through SearchTool, then pi materializes their definitions from
   * `ToolResultMessage.addedToolNames`. A no-op for models whose compat data
   * does not advertise native deferred-tool support. Off by default.
   */
  readonly deferTools?: boolean;
}

export class Agent<TContext = unknown> {
  readonly name: string;
  readonly instructions?: AgentConfig<TContext>["instructions"];
  readonly handoffDescription?: string;
  readonly model?: string | ChatModel;
  readonly modelSettings?: AgentConfig<TContext>["modelSettings"];
  readonly tools: readonly Tool[];
  readonly handoffs: readonly Handoff<TContext>[];
  readonly subagents: readonly Agent<TContext>[];
  readonly guardrails: AgentGuardrails<TContext>;
  readonly outputType?: unknown;
  readonly maxStepsPerTurn?: number;
  readonly deferTools?: boolean;

  constructor(config: AgentConfig<TContext>) {
    if (!config.name) throw new Error("Agent requires a non-empty `name`.");
    this.name = config.name;
    this.instructions = config.instructions;
    this.handoffDescription = config.handoffDescription;
    this.model = config.model;
    this.modelSettings = config.modelSettings;
    this.tools = config.tools ?? [];
    this.handoffs = config.handoffs ?? [];
    this.subagents = config.subagents ?? [];
    this.guardrails = config.guardrails ?? {};
    this.outputType = config.outputType;
    this.maxStepsPerTurn = config.maxStepsPerTurn;
    this.deferTools = config.deferTools;
  }

  async resolveInstructions(ctx: AgentRunContext<TContext>): Promise<string | undefined> {
    if (typeof this.instructions === "function") return this.instructions(ctx);
    return this.instructions;
  }
}

export function defineAgent<TContext = unknown>(config: AgentConfig<TContext>): Agent<TContext> {
  return new Agent(config);
}
