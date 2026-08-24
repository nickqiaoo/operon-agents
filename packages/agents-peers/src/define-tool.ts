/**
 * A local `defineTool` with the same shape as operon-agents-core's, kept here so this package
 * VALUE-imports nothing from the framework: a file-extension bundle of it must not drag the core
 * barrel (and its native transitive deps) into the bundle. `Tool` and friends are types only.
 */
import { z, type ZodType } from "zod";
import type { Tool, ToolPlan, ToolResolveContext } from "operon-agents-core";

export interface ToolDef<S extends ZodType> {
  readonly name: string;
  readonly description: string;
  readonly params: S;
  readonly resolve: (args: z.infer<S>, ctx: ToolResolveContext) => ToolPlan | Promise<ToolPlan>;
}

/** Build a full-control tool: zod params → JSON Schema, parsed args → `resolve` → the plan. */
export function defineTool<S extends ZodType>(def: ToolDef<S>): Tool {
  const parameters = z.toJSONSchema(def.params) as Record<string, unknown>;
  return {
    schema: { name: def.name, description: def.description, parameters },
    resolve(rawArgs, ctx) {
      return def.resolve(def.params.parse(rawArgs) as z.infer<S>, ctx);
    },
  };
}
