/**
 * Context breakdown — a per-turn snapshot of how the model's context window is spent,
 * mirroring what a `/context` view shows: system prompt, tool schemas, conversation, the
 * turn-boundary injections (skills catalog, todo/task mirrors, …), the compaction reserve,
 * and the free remainder.
 *
 * The numbers are ESTIMATES (same char/4 heuristic the compaction strategy uses), computed
 * from exactly the `{ system, tools, messages }` the Runner is about to send — so the buckets
 * sum to the real request, not a separate re-derivation.
 */
import type { ChatModel } from "../llm/define-model.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import { estimateTokens, estimateTokensForMessages } from "../capabilities/compaction/tokens.ts";
import { isMcpToolName } from "../mcp/tool-naming.ts";

/** One additive slice of the context window: its token estimate and share of the whole window. */
export interface ContextSlice {
  readonly tokens: number;
  /** Percent of the full context window, 0..100. */
  readonly percent: number;
}

/** A single turn-boundary injector's contribution (a subset of the conversation framing). */
export interface ContextInjectionSlice extends ContextSlice {
  /** The injector id (e.g. `skill_catalog`, `todo`, `task`, `plan_mode`, `goal`). */
  readonly id: string;
}

export interface ContextBreakdown {
  /** The active model's full context window (tokens). */
  readonly contextWindow: number;
  readonly model: string;
  /** systemPrompt + tools + messages + injections (everything actually sent this turn). */
  readonly used: number;
  readonly usedPercent: number;

  readonly systemPrompt: ContextSlice;
  /** Built-in / handoff / spawn tool schemas. */
  readonly toolsBuiltin: ContextSlice;
  /** MCP tool schemas (`mcp__*`). */
  readonly toolsMcp: ContextSlice;
  /** Conversation messages, EXCLUDING the turn-boundary injections broken out below. */
  readonly messages: ContextSlice;
  /** Turn-boundary injections (skills/todo/task/…), largest first. */
  readonly injections: readonly ContextInjectionSlice[];
  /** Tokens the compaction strategy reserves before the window fills (0 if no compaction). */
  readonly compactBuffer: ContextSlice;
  /** contextWindow − used − compactBuffer, clamped at 0. */
  readonly free: ContextSlice;

  /** Epoch ms the snapshot was taken (turn boundary). */
  readonly capturedAt: number;
}

export interface ComputeContextBreakdownInput {
  readonly model: ChatModel;
  readonly system: string | undefined;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  /** Per-injector token estimates captured while injecting at the turn boundary. */
  readonly injectionTokens: ReadonlyMap<string, number>;
  /** Compaction reserve (`CompactionService.reservedContextTokens`), or 0 if absent. */
  readonly compactBufferTokens: number;
  readonly capturedAt: number;
}

export function computeContextBreakdown(input: ComputeContextBreakdownInput): ContextBreakdown {
  const window = input.model.contextWindow;
  const pct = (tokens: number): number => (window > 0 ? (tokens / window) * 100 : 0);
  const slice = (tokens: number): ContextSlice => ({ tokens, percent: pct(tokens) });

  const systemTokens = estimateTokens(input.system ?? "");

  let builtinTools = 0;
  let mcpTools = 0;
  for (const tool of input.tools) {
    const tokens = estimateTokens(JSON.stringify(tool.schema));
    if (isMcpToolName(tool.schema.name)) mcpTools += tokens;
    else builtinTools += tokens;
  }

  // `messages` includes the injection reminders (they are appended as messages at the boundary);
  // subtract the per-injector estimates so the two lines don't double-count.
  const messagesTotal = estimateTokensForMessages(input.messages);
  let injectionsTotal = 0;
  const injections: ContextInjectionSlice[] = [];
  for (const [id, tokens] of input.injectionTokens) {
    injectionsTotal += tokens;
    injections.push({ id, tokens, percent: pct(tokens) });
  }
  injections.sort((a, b) => b.tokens - a.tokens);
  const conversationTokens = Math.max(0, messagesTotal - injectionsTotal);

  const used = systemTokens + builtinTools + mcpTools + messagesTotal;
  const free = Math.max(0, window - used - input.compactBufferTokens);

  return {
    contextWindow: window,
    model: input.model.id,
    used,
    usedPercent: pct(used),
    systemPrompt: slice(systemTokens),
    toolsBuiltin: slice(builtinTools),
    toolsMcp: slice(mcpTools),
    messages: slice(conversationTokens),
    injections,
    compactBuffer: slice(input.compactBufferTokens),
    free: slice(free),
    capturedAt: input.capturedAt,
  };
}
