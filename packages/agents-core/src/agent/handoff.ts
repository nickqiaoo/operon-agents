import { z } from "zod";
import type { Message } from "../protocol/index.ts";
import { defineTool } from "../tool/define.ts";
import { ToolAccesses } from "../tool/access.ts";
import type { Tool } from "../tool/types.ts";
import type { Agent, AgentRunContext } from "./agent.ts";

export interface HandoffInputData {
  readonly history: readonly Message[];
}

export type HandoffInputFilter = (data: HandoffInputData) => HandoffInputData;

/** Default handoff-tool args when no `inputType` is given: an optional free-text `reason`. */
const DEFAULT_HANDOFF_PARAMS = z.object({
  reason: z.string().optional().describe("Why control is being transferred (optional)."),
});

export interface HandoffOptions<TContext = unknown, TInput = { reason?: string }> {
  readonly toolName?: string;
  readonly toolDescription?: string;
  readonly inputFilter?: HandoffInputFilter;
  /**
   * Schema for the args the model must produce when it calls this handoff tool. Defaults to
   * `{ reason?: string }`. Pass a Zod object to require structured input at handoff time (e.g.
   * `z.object({ orderId: z.string() })`); the framework validates the model's args against it
   * before transferring (invalid args fail the tool call, so the transfer does not happen), and
   * the validated value is what `onHandoff` receives.
   */
  readonly inputType?: z.ZodType<TInput>;
  /** Runs when the handoff is invoked, with the validated tool args (typed by `inputType`). */
  readonly onHandoff?: (ctx: AgentRunContext<TContext>, input: TInput) => void | Promise<void>;
}

export function toFunctionToolName(name: string): string {
  // Each disallowed char maps to its own "_" — no run-collapsing. Generated names land
  // in transcripts (transfer_to_*/agent_* tool calls), so the mapping must stay stable.
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  return cleaned || "agent";
}

export function getTransferMessage(agentName: string): string {
  return JSON.stringify({ assistant: agentName });
}

/** Best-effort string `reason` from validated handoff args, for the tool-call display line. */
function reasonOf(args: unknown): string | undefined {
  if (args !== null && typeof args === "object" && "reason" in args) {
    const reason = (args as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return undefined;
}

export class Handoff<TContext = unknown> {
  readonly toolName: string;
  readonly toolDescription: string;
  readonly target: Agent<TContext>;
  readonly inputFilter?: HandoffInputFilter;
  /** The args schema exposed to the model; `undefined` → the default `{ reason?: string }`. */
  readonly inputType?: z.ZodType;
  // Stored erased (`input: any`): the args schema varies per handoff, but `Agent.handoffs` holds a
  // uniform `Handoff<TContext>[]`. Type safety lives on `HandoffOptions`/`handoff()`, not here.
  readonly onHandoff?: (ctx: AgentRunContext<TContext>, input: any) => void | Promise<void>;

  constructor(target: Agent<TContext>, options: HandoffOptions<TContext, any> = {}) {
    this.target = target;
    this.toolName = options.toolName ?? `transfer_to_${toFunctionToolName(target.name)}`;
    this.toolDescription =
      options.toolDescription ??
      `Handoff to the ${target.name} agent to handle the request.${
        target.handoffDescription ? ` ${target.handoffDescription}` : ""
      }`;
    this.inputFilter = options.inputFilter;
    this.inputType = options.inputType;
    this.onHandoff = options.onHandoff;
  }

  asTool(): Tool {
    const targetName = this.target.name;
    const toolName = this.toolName;
    // A custom `inputType` replaces the model-facing args schema; otherwise the default `reason`.
    // The tool framework validates args against it, so `resolve`/`onHandoff` see parsed values.
    const params: z.ZodType = this.inputType ?? DEFAULT_HANDOFF_PARAMS;
    return defineTool({
      name: toolName,
      description: this.toolDescription,
      params,
      resolve: (args) => ({
        approvalRule: toolName,
        accesses: ToolAccesses.none(),
        handoff: { targetAgentName: targetName },
        controlFlow: true,
        display: { title: `Handoff → ${targetName}`, detail: reasonOf(args) },
        run: async () => ({ content: [{ type: "text", text: getTransferMessage(targetName) }] }),
      }),
    });
  }
}

export function handoff<TContext = unknown, TInput = { reason?: string }>(
  target: Agent<TContext>,
  options?: HandoffOptions<TContext, TInput>,
): Handoff<TContext> {
  return new Handoff(target, options);
}
