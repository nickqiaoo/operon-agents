import type { Tool } from "./types.ts";
import type { FrameEnvironments } from "./environment-table.ts";

/** The parameter a multi-environment frame adds to every environment-scoped tool. */
export const TARGET_PARAMETER = "target";

export type TargetParameterOutcome =
  | { readonly kind: "unchanged"; readonly tool: Tool }
  | { readonly kind: "added"; readonly tool: Tool }
  /** The tool already has a parameter of that name: it keeps it, and runs on the home environment only. */
  | { readonly kind: "conflict"; readonly tool: Tool };

const cache = new WeakMap<Tool, Map<string, TargetParameterOutcome>>();

/**
 * The tool as a multi-environment frame offers it: an environment-scoped tool gains an optional
 * `target` (an enum of the frame's environment names), everything else is returned as is. The
 * frame's table is fixed for the session, so the same frame gets byte-identical schemas every
 * turn and the cached prompt prefix holds.
 *
 * The wrapper is a prototype child of the tool: every method and tag (source, auto-approval
 * projection) is the original's; only `schema` differs. `target` itself is consumed by the
 * tool-call layer before `resolve`, so the tool never sees it.
 */
export function withTargetParameter(tool: Tool, frame: FrameEnvironments): TargetParameterOutcome {
  if (tool.environmentScoped !== true) return { kind: "unchanged", tool };
  const names = [...frame.reachable.keys()];
  const key = `${frame.home}\u0000${names.join("\u0000")}`;
  let byFrame = cache.get(tool);
  const hit = byFrame?.get(key);
  if (hit !== undefined) return hit;

  const parameters = tool.schema.parameters as Record<string, unknown> | undefined;
  const properties = parameters?.["properties"];
  let outcome: TargetParameterOutcome;
  if (parameters === undefined || parameters["type"] !== "object" || (properties !== undefined && (typeof properties !== "object" || properties === null))) {
    // Not an object schema: nowhere to put the parameter. The tool stays on the home environment.
    outcome = { kind: "conflict", tool: notScoped(tool) };
  } else if (properties !== undefined && Object.hasOwn(properties, TARGET_PARAMETER)) {
    outcome = { kind: "conflict", tool: notScoped(tool) };
  } else if (names.length <= 1) {
    outcome = { kind: "unchanged", tool };
  } else {
    const target = {
      type: "string",
      enum: names,
      description: `Environment to run in: one of ${names.map((name) => `"${name}"`).join(", ")}. Omit to run on "${frame.home}".`,
    };
    const schema = {
      ...tool.schema,
      parameters: { ...parameters, properties: { ...(properties as Record<string, unknown> | undefined), [TARGET_PARAMETER]: target } },
    };
    const wrapped = Object.create(tool) as Tool;
    Object.defineProperty(wrapped, "schema", { value: schema, enumerable: true });
    outcome = { kind: "added", tool: wrapped };
  }
  if (byFrame === undefined) {
    byFrame = new Map();
    cache.set(tool, byFrame);
  }
  byFrame.set(key, outcome);
  return outcome;
}

function notScoped(tool: Tool): Tool {
  const wrapped = Object.create(tool) as Tool;
  Object.defineProperty(wrapped, "environmentScoped", { value: false, enumerable: true });
  return wrapped;
}
