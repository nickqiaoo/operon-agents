import type { PermissionPolicy } from "../../permission/types.ts";
import type { Capability } from "../capability.ts";
import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../injection.ts";
import { HookEngine } from "./engine.ts";
import type { HookDef } from "./types.ts";

export { HookEngine } from "./engine.ts";
export type { HookDef, HookEventType } from "./types.ts";
export { HOOK_EVENT_TYPES } from "./types.ts";

function preToolCallHookPolicy(engine: HookEngine): PermissionPolicy {
  return {
    name: "pre-tool-call-hook",
    async evaluate(ctx) {
      if (!engine.has("PreToolUse")) return undefined;
      const result = await engine.triggerBlock("PreToolUse", {
        matcherValue: ctx.toolCall.name,
        inputData: {
          tool_name: ctx.toolCall.name,
          tool_input: ctx.args,
          approval_rule: ctx.plan.approvalRule,
        },
        signal: ctx.signal,
      });
      if (result?.block) return { kind: "deny", message: result.reason ?? "Blocked by a PreToolUse hook." };
      return undefined;
    },
  };
}

class SessionStartInjector extends BoundaryInjector {
  readonly id = "user_hooks_session_start";
  private readonly getOutput: () => string | null;

  constructor(getOutput: () => string | null) {
    super();
    this.getOutput = getOutput;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    if (this.restoreInjectedAt(ctx, ["session_start"])) return null;
    const output = this.getOutput();
    return output && output.trim().length > 0 ? { text: output, variant: "session_start" } : null;
  }
}

/**
 * Shell hooks (the `PreToolUse`/`Stop`/… lifecycle contract) are a peer capability of
 * the extension runtime, not a client of it. The two intervention points that need a return
 * value are a permission policy and a loop hook; everything else is pure observation, which
 * subscribes to the session event sink directly — no extension registry in between.
 */
export function userHooksCapability(hooks: readonly HookDef[]): Capability {
  const engine = new HookEngine(hooks);
  let sessionStartOutput: string | null = null;
  let continuedViaStop = false;
  let unsubscribe: (() => void) | undefined;

  return {
    name: "user-hooks",
    policies: [preToolCallHookPolicy(engine)],
    injectors: [new SessionStartInjector(() => sessionStartOutput)],
    hooks: {
      // Stop — a hook may force exactly one more turn (by design: at most one continuation).
      shouldContinueAfterStop: async (ctx) => {
        if (continuedViaStop || ctx.stopReason !== "end_turn" || !engine.has("Stop")) return undefined;
        const result = await engine.triggerBlock("Stop", { inputData: { stop_reason: ctx.stopReason }, signal: ctx.signal });
        if (result?.block) {
          continuedViaStop = true;
          return { continue: true };
        }
        return undefined;
      },
    },
    service: engine,
    openSession: async (ctx) => {
      engine.attachMachine(ctx.machine);
      if (engine.has("SessionStart")) {
        sessionStartOutput = await engine
          .trigger("SessionStart", { inputData: { session_id: ctx.sessionId }, signal: ctx.signal })
          .catch(() => null);
      }
      unsubscribe = ctx.events.subscribe((event) => observeShellHookEvent(engine, event));
    },
    closeSession: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (engine.has("SessionEnd")) engine.fireAndForgetTrigger("SessionEnd", {});
    },
  };
}

function observeShellHookEvent(engine: HookEngine, event: import("../../events/index.ts").AgentEvent): void {
  switch (event.type) {
    case "agent.started":
      if (event.address.includes("/") && engine.has("SubagentStart")) {
        engine.fireAndForgetTrigger("SubagentStart", { matcherValue: event.agent, inputData: { agent: event.agent, address: event.address } });
      }
      break;
    case "agent.ended":
      if (event.address.includes("/") && engine.has("SubagentStop")) {
        engine.fireAndForgetTrigger("SubagentStop", { matcherValue: event.agent, inputData: { agent: event.agent, address: event.address } });
      }
      break;
    case "tool.result": {
      const hookEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
      if (engine.has(hookEvent)) {
        engine.fireAndForgetTrigger(hookEvent, {
          matcherValue: event.toolName,
          inputData: { tool_name: event.toolName, is_error: event.isError },
        });
      }
      break;
    }
    case "compaction.started":
      if (engine.has("PreCompact")) engine.fireAndForgetTrigger("PreCompact", { inputData: { trigger: event.trigger } });
      break;
    case "compaction.completed":
      if (engine.has("PostCompact")) {
        engine.fireAndForgetTrigger("PostCompact", { inputData: { tokens_before: event.tokensBefore, tokens_after: event.tokensAfter, compacted_count: event.compactedCount } });
      }
      break;
    case "warning":
    case "error":
      if (engine.has("Notification")) engine.fireAndForgetTrigger("Notification", { matcherValue: event.message, inputData: { level: event.type, message: event.message } });
      break;
    default:
      break;
  }
}
