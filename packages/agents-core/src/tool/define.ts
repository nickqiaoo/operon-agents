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

/**
 * The full-control tool definition: `resolve(args)` runs BEFORE authorization and returns
 * the complete `ToolPlan` — `approvalRule` (and everything else plan-level: `accesses`,
 * `matchesRule`, `display`, `controlFlow`, `handoff`, `stopBatchAfterThis`) is computed
 * there, which is why this shape has no top-level `approvalRule` field like
 * {@link FunctionToolDef} does: the plan is its single source of truth.
 *
 * Choosing between the two APIs: reach for {@link tool} (the simple execute-only shape)
 * unless you need resolve-time work — pre-approval validation (e.g. against
 * `ctx.fileLedger`), plan fields beyond approvalRule/accesses/display, or an
 * args-dependent plan structure.
 */
export interface ToolDef<S extends ZodType> {
  readonly name: string;
  readonly description: string;
  readonly params: S;
  readonly resolve: (args: z.infer<S>, ctx: ToolResolveContext) => ToolPlan | Promise<ToolPlan>;
  /** Security-relevant projection for the `auto`-mode judge. See `Tool.toAutoApprovalInput`. */
  readonly toAutoApprovalInput?: (args: z.infer<S>) => unknown;
}

/** Build a tool from a {@link ToolDef}. See that type's doc for when to prefer {@link tool}. */
export function defineTool<S extends ZodType>(def: ToolDef<S>): Tool {
  const parameters = z.toJSONSchema(def.params) as Record<string, unknown>;
  return {
    schema: { name: def.name, description: def.description, parameters },
    resolve(rawArgs, ctx) {
      const args = def.params.parse(rawArgs) as z.infer<S>;
      return def.resolve(args, ctx);
    },
    // Project from the raw (history) args. The judge passes unvalidated tool_use input from
    // the transcript, so parse defensively and let the judge's try/catch handle throws.
    ...(def.toAutoApprovalInput
      ? { toAutoApprovalInput: (rawArgs: unknown) => def.toAutoApprovalInput!(def.params.parse(rawArgs) as z.infer<S>) }
      : {}),
  };
}

export type ToolReturn = string | ToolResultContent | ToolResult;

/**
 * The simple tool definition (OpenAI-parity function tool): one `execute` plus optional
 * plan sugar — `approvalRule` (string, or computed from args; defaults to the tool name),
 * `accesses`, `display`. It expands into the same `ToolPlan` a {@link ToolDef} builds by
 * hand; for resolve-time validation or plan fields not exposed here, use
 * {@link defineTool} instead.
 */
export interface FunctionToolDef<S extends ZodType> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly execute: (args: z.infer<S>, ctx: ToolRunContext) => ToolReturn | Promise<ToolReturn>;
  readonly approvalRule?: string | ((args: z.infer<S>) => string);
  readonly accesses?: ToolAccesses;
  readonly display?: (args: z.infer<S>) => ToolDisplay;
  /** Security-relevant projection for the `auto`-mode judge. See `Tool.toAutoApprovalInput`. */
  readonly toAutoApprovalInput?: (args: z.infer<S>) => unknown;
}

/** Build a tool from a {@link FunctionToolDef} — the right default for most tools. */
export function tool<S extends ZodType>(def: FunctionToolDef<S>): Tool {
  const parameters = z.toJSONSchema(def.parameters) as Record<string, unknown>;
  return {
    schema: { name: def.name, description: def.description, parameters },
    ...(def.toAutoApprovalInput
      ? { toAutoApprovalInput: (rawArgs: unknown) => def.toAutoApprovalInput!(def.parameters.parse(rawArgs) as z.infer<S>) }
      : {}),
    resolve(rawArgs) {
      const args = def.parameters.parse(rawArgs) as z.infer<S>;
      const approvalRule =
        typeof def.approvalRule === "function" ? def.approvalRule(args) : def.approvalRule ?? def.name;
      return {
        approvalRule,
        accesses: def.accesses,
        display: def.display?.(args),
        run: async (ctx) => normalizeToolReturn(await def.execute(args, ctx)),
      };
    },
  };
}

function normalizeToolReturn(value: ToolReturn): ToolResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value };
  return value;
}
