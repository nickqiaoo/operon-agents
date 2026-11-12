/**
 * Context breakdown — a per-turn snapshot of how the model's context window is spent,
 * mirroring what a `/context` view shows: system prompt, tool schemas, conversation, the
 * turn-boundary injections (skills catalog, todo/task mirrors, …), the compaction reserve,
 * and the free remainder.
 *
 * Total occupancy comes from the provider's last measured request when available. Category
 * weights are estimates of `{ system, tools, messages }`, normalised to that measured total.
 * Before any usage is available (or after history replacement), the total is estimated too.
 */
import type { ChatModel } from "../llm/define-model.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import { estimateTokens, estimateTokensForMessages } from "../capabilities/compaction/tokens.ts";
import { isMcpToolName } from "../mcp/tool-naming.ts";

/** Estimated attribution of occupancy; normalised to the provider total when available. */
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
  /** Last measured input occupancy; falls back to an estimate until provider usage is available. */
  readonly used: number;
  readonly usageSource: "provider" | "estimate";
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

  /** Epoch ms the snapshot was taken (turn boundary, then each step's request). */
  readonly capturedAt: number;
}

export interface ComputeContextBreakdownInput {
  readonly model: ChatModel;
  readonly system: string | undefined;
  readonly tools: readonly Pick<Tool, "schema">[];
  readonly messages: readonly Message[];
  /** Per-injector token estimates captured while injecting at the turn boundary. */
  readonly injectionTokens: ReadonlyMap<string, number>;
  /** Compaction reserve (`CompactionService.reservedContextTokens`), or 0 if absent. */
  readonly compactBufferTokens: number;
  readonly capturedAt: number;
  /** Exact input tokens, including cached input, from the latest provider response. */
  readonly observedInputTokens?: number;
}

export function computeContextBreakdown(input: ComputeContextBreakdownInput): ContextBreakdown {
  const window = input.model.contextWindow;
  const pct = (tokens: number): number => (window > 0 ? (tokens / window) * 100 : 0);
  const slice = (tokens: number): ContextSlice => ({ tokens, percent: pct(tokens) });

  const systemTokens = estimateTokens(input.system ?? "");

  let builtinTools = 0;
  let mcpTools = 0;
  for (const tool of input.tools) {
    // What goes on the wire: `outputSchema` is for programs calling the tool, never sent to the model.
    const { outputSchema: _programOnly, ...sent } = tool.schema;
    const tokens = estimateTokens(JSON.stringify(sent));
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

  const estimatedUsed = systemTokens + builtinTools + mcpTools + messagesTotal;
  const observed = input.observedInputTokens;
  const measured = observed !== undefined && Number.isFinite(observed) && observed > 0;
  const used = measured ? observed : estimatedUsed;
  // Allocate rounded estimates cumulatively so every category adds up to the measured total.
  // These remain attribution estimates, not provider-supplied per-category token counts.
  let estimatedSoFar = 0;
  let allocated = 0;
  const attributed = (tokens: number): ContextSlice => {
    if (!measured || estimatedUsed === 0) return slice(tokens);
    estimatedSoFar += tokens;
    const next = Math.round(estimatedSoFar / estimatedUsed * used);
    const result = slice(Math.max(0, next - allocated));
    allocated = next;
    return result;
  };
  const systemSlice = attributed(systemTokens);
  const builtinSlice = attributed(builtinTools);
  const mcpSlice = attributed(mcpTools);
  // Stale injection estimates must not create extra occupancy.
  let injectionRemaining = messagesTotal;
  const attributedInjections = injections.map((item) => {
    const tokens = Math.min(item.tokens, injectionRemaining);
    injectionRemaining -= tokens;
    return { id: item.id, ...attributed(tokens) };
  });
  const messagesSlice = measured && estimatedUsed === 0
    ? slice(used)
    : attributed(measured ? injectionRemaining : conversationTokens);
  const free = Math.max(0, window - used - input.compactBufferTokens);

  return {
    contextWindow: window,
    model: input.model.id,
    used,
    usageSource: measured ? "provider" : "estimate",
    usedPercent: pct(used),
    systemPrompt: systemSlice,
    toolsBuiltin: builtinSlice,
    toolsMcp: mcpSlice,
    messages: messagesSlice,
    injections: measured ? attributedInjections : injections,
    compactBuffer: slice(input.compactBufferTokens),
    free: slice(free),
    capturedAt: input.capturedAt,
  };
}
