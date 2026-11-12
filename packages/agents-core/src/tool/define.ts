import { z, type ZodType } from "zod";
import type {
  Tool,
  ToolAccesses,
  ToolDisplay,
  ToolPlan,
  ToolResolveContext,
  ToolResult,
  ToolResultContent,
  ToolRunContext,
} from "./types.ts";

export type ToolReturn = string | ToolResultContent | ToolResult;

interface ToolDefBase<S extends ZodType> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  /** Security-relevant projection for the `auto`-mode judge. See `Tool.toAutoApprovalInput`. */
  readonly toAutoApprovalInput?: (args: z.infer<S>) => unknown;
}

/**
 * The simple tool definition (OpenAI-parity function tool) and the right default for most tools:
 * one `execute` plus optional plan sugar — `approvalRule` (string, or computed from args; defaults
 * to the tool name), `accesses`, `display`. It expands into the same `ToolPlan` a
 * {@link ResolveToolDef} builds by hand.
 */
export interface FunctionToolDef<S extends ZodType, TContext = unknown> extends ToolDefBase<S> {
  readonly execute: (args: z.infer<S>, ctx: ToolRunContext<TContext>) => ToolReturn | Promise<ToolReturn>;
  readonly approvalRule?: string | ((args: z.infer<S>) => string);
  readonly accesses?: ToolAccesses;
  readonly display?: (args: z.infer<S>) => ToolDisplay;
}

/**
 * The full-control tool definition: `resolve(args)` runs BEFORE authorization and returns
 * the complete `ToolPlan` — `approvalRule` (and everything else plan-level: `accesses`,
 * `matchesRule`, `display`, `controlFlow`, `handoff`, `stopBatchAfterThis`) is computed
 * there, which is why this shape has no top-level `approvalRule` field like
 * {@link FunctionToolDef} does: the plan is its single source of truth.
 *
 * Reach for it only when you need resolve-time work — pre-approval validation, plan fields beyond approvalRule/accesses/display, or an args-dependent
 * plan structure.
 */
export interface ResolveToolDef<S extends ZodType, TContext = unknown> extends ToolDefBase<S> {
  readonly resolve: (args: z.infer<S>, ctx: ToolResolveContext<TContext>) => ToolPlan | Promise<ToolPlan>;
}

/**
 * Build a tool: pass `execute` for the simple form, or `resolve` for full control over its plan.
 * `TContext` declares the host context `ctx.context` carries (see `ToolContextBase.context`).
 */
export function defineTool<S extends ZodType, TContext = unknown>(def: FunctionToolDef<S, TContext>): Tool;
export function defineTool<S extends ZodType, TContext = unknown>(def: ResolveToolDef<S, TContext>): Tool;
export function defineTool<S extends ZodType, TContext = unknown>(def: FunctionToolDef<S, TContext> | ResolveToolDef<S, TContext>): Tool {
  const parameters = z.toJSONSchema(def.parameters) as Record<string, unknown>;
  const parse = (rawArgs: unknown): z.infer<S> => def.parameters.parse(rawArgs) as z.infer<S>;
  return {
    schema: { name: def.name, description: def.description, parameters },
    // Project from the raw (history) args. The judge passes unvalidated tool_use input from
    // the transcript, so parse defensively and let the judge's try/catch handle throws.
    ...(def.toAutoApprovalInput
      ? { toAutoApprovalInput: (rawArgs: unknown) => def.toAutoApprovalInput!(parse(rawArgs)) }
      : {}),
    resolve(rawArgs, ctx) {
      const args = parse(rawArgs);
      if ("resolve" in def) return def.resolve(args, ctx as ToolResolveContext<TContext>);
      const approvalRule =
        typeof def.approvalRule === "function" ? def.approvalRule(args) : def.approvalRule ?? def.name;
      return {
        approvalRule,
        accesses: def.accesses,
        display: def.display?.(args),
        run: async (runCtx) => normalizeToolReturn(await def.execute(args, runCtx as ToolRunContext<TContext>)),
      };
    },
  };
}

function normalizeToolReturn(value: ToolReturn): ToolResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value };
  return value;
}
