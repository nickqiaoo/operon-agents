/**
 * Structured-output enforcement.
 *
 * Instead of asking the subagent to emit JSON as prose and parsing the text
 * (fragile), we inject a `StructuredOutput` tool whose parameter schema IS the
 * caller's JSON Schema. The subagent is forced to call it; calling it ends the
 * turn (`stopTurn`) and captures the argument. We then validate with Ajv and, on
 * a miss (or no call), nudge in the SAME conversation and retry.
 */

import Ajv, { type ValidateFunction } from "ajv";
import { Agent } from "../agent.ts";
import type { Tool } from "../../tool/types.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

/** Compile (and cache) an Ajv validator for a JSON Schema. Throws if invalid. */
export function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const cacheKey = JSON.stringify(schema);
  const existing = validators.get(cacheKey);
  if (existing) return existing;
  const compiled = ajv.compile(schema);
  validators.set(cacheKey, compiled);
  return compiled;
}

export function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const validate = getValidator(schema);
  if (validate(value)) return { ok: true };
  return { ok: false, error: ajv.errorsText(validate.errors, { separator: "; " }) };
}

/** Mutable capture cell shared between the injected tool and the run loop. */
export interface StructuredCapture {
  called: boolean;
  value: unknown;
}

/** Build a StructuredOutput tool whose parameters are the given JSON Schema. */
export function makeStructuredOutputTool(schema: Record<string, unknown>): {
  tool: Tool;
  capture: StructuredCapture;
} {
  const capture: StructuredCapture = { called: false, value: undefined };
  let pending: unknown;
  const tool: Tool = {
    schema: {
      name: "StructuredOutput",
      description:
        "Return your final answer as a single object matching the required JSON schema. " +
        "Call this exactly once — its argument IS your answer, and calling it ends your turn. " +
        "Do not put the answer in prose.",
      parameters: schema,
    },
    resolve: (args) => {
      pending = args;
      return {
        approvalRule: "StructuredOutput",
        run: async () => {
          capture.called = true;
          capture.value = pending;
          return { content: [{ type: "text", text: "Structured output recorded." }], stopTurn: true };
        },
      };
    },
  };
  return { tool, capture };
}

/** Clone an agent, appending one extra tool (the StructuredOutput injector). */
export function cloneAgentWithTool<TContext>(sub: Agent<TContext>, extra: Tool): Agent<TContext> {
  return new Agent<TContext>({
    name: sub.name,
    instructions: sub.instructions,
    handoffDescription: sub.handoffDescription,
    model: sub.model,
    modelSettings: sub.modelSettings,
    tools: [...sub.tools, extra],
    handoffs: sub.handoffs,
    subagents: sub.subagents,
    guardrails: sub.guardrails,
    outputType: sub.outputType,
    maxStepsPerTurn: sub.maxStepsPerTurn,
  });
}

/** Instruction appended to the prompt so the subagent knows to call the tool. */
export function structuredInstruction(schema: Record<string, unknown>): string {
  return (
    "\n\nIMPORTANT: When you have your answer, call the StructuredOutput tool exactly once " +
    "with a single argument matching this JSON Schema. The tool argument IS your answer — " +
    "do not also write it as prose.\nSchema:\n" +
    JSON.stringify(schema, null, 2)
  );
}
