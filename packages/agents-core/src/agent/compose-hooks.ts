import type {
  AfterModelResponseHook,
  AuthorizeToolExecutionResult,
  BeforeModelRequestResult,
  BeforeStepResult,
  FinalizeToolResultHook,
  LoopHooks,
  PrepareToolExecutionResult,
} from "../loop/types.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import type { ConversationContext } from "../loop/context.ts";
import type { Agent } from "./agent.ts";
import { toolInputGuardrailHook, toolOutputGuardrailHook } from "./guardrail.ts";
import { runCtxFor } from "./run-support.ts";
import type { RunState } from "./runner.ts";
import { withToolCallRecoveryContext } from "./recovery.ts";

/**
 * The loop hooks for one turn of `active` under a frame: capability hook parts
 * (compaction beforeStep/afterStep …) → permission authorizer (single) → tool guardrails.
 * Extracted from the Engine; only TYPES are imported from `runner.ts`.
 */
export function buildRunHooks<TContext>(
  active: Agent<TContext>,
  state: RunState<TContext>,
  context: ConversationContext,
  tools: readonly Tool[],
): LoopHooks {
  const ctx = runCtxFor(state);
  const parts: Array<Partial<LoopHooks> | undefined> = [...state.capabilities.loopHookParts];
  parts.push({ authorizeToolExecution: buildAuthorizer(state, context, tools) });
  if (active.guardrails.toolInput && active.guardrails.toolInput.length > 0) {
    parts.push({ prepareToolExecution: toolInputGuardrailHook(active, ctx, active.guardrails.toolInput) });
  }
  if (active.guardrails.toolOutput && active.guardrails.toolOutput.length > 0) {
    parts.push({ finalizeToolResult: toolOutputGuardrailHook(active, ctx, active.guardrails.toolOutput) });
  }
  // Last request transform: capability hooks may rewrite the message list, so recovery must
  // inspect their final shape. It is request-only and never journals synthetic history.
  parts.push({
    beforeModelRequest: async ({ request }) => {
      const recovered = await withToolCallRecoveryContext(state, request);
      return recovered === request ? undefined : { request: recovered };
    },
  });
  return composeLoopHooks(parts);
}

function buildAuthorizer<TContext>(
  state: RunState<TContext>,
  context: ConversationContext,
  tools: readonly Tool[],
): LoopHooks["authorizeToolExecution"] {
  // The `auto`-mode judge needs THIS frame's live transcript + tool registry (the authorize
  // ctx carries neither). Bind them per turn as closure state — the manager is a session
  // singleton shared by concurrent frames, so they must never be stored on it.
  const base = state.permission.authorizerFor({ getTranscript: () => context.messages, getTools: () => tools });
  const answers = state.answers;
  if (!answers) return base;
  return async (ctx) => {
    const answer = answers[ctx.toolCall.id];
    if (answer) {
      // Audit record: this is the single chokepoint both live and durable approvals
      // flow through (the responder/resume answer is applied here).
      context.record({ type: "permission.record_approval", toolCallId: ctx.toolCall.id, toolName: ctx.toolCall.name, decision: answer.decision, feedback: answer.feedback, approvalRule: ctx.plan.approvalRule, scope: answer.scope });
      const ok = state.permission.applyApproval(ctx.plan.approvalRule, answer);
      if (ok) return undefined;
      return { block: true, reason: answer.feedback ?? `Tool ${ctx.toolCall.name} was ${answer.decision}.` };
    }
    return base(ctx);
  };
}

export function composeLoopHooks(parts: ReadonlyArray<Partial<LoopHooks> | undefined>): LoopHooks {
  const list = parts.filter((h): h is Partial<LoopHooks> => h !== undefined);

  const beforeSteps = list.map((h) => h.beforeStep).filter(isDefined);
  const afterSteps = list.map((h) => h.afterStep).filter(isDefined);
  const beforeModelRequests = list.map((h) => h.beforeModelRequest).filter(isDefined);
  const afterModelResponses = list.map((h) => h.afterModelResponse).filter(isDefined);
  const prepares = list.map((h) => h.prepareToolExecution).filter(isDefined);
  const authorizers = list.map((h) => h.authorizeToolExecution).filter(isDefined);
  const finalizers = list.map((h) => h.finalizeToolResult).filter(isDefined);
  const continuers = list.map((h) => h.shouldContinueAfterStop).filter(isDefined);
  const recoverers = list.map((h) => h.recoverStepError).filter(isDefined);

  const composed: LoopHooks = {};

  if (beforeSteps.length > 0) {
    composed.beforeStep = async (ctx) => {
      // `system` chains like the other transform slots: each hook sees the previous rewrite,
      // and only a real change is reported back so the step keeps the agent-resolved default.
      let system = ctx.system;
      let changed = false;
      for (const hook of beforeSteps) {
        const result: BeforeStepResult | undefined = await hook(changed ? { ...ctx, system } : ctx);
        if (result?.block === true) return result;
        if (result?.system !== undefined) {
          system = result.system;
          changed = true;
        }
      }
      return changed ? { system } : undefined;
    };
  }

  if (afterSteps.length > 0) {
    composed.afterStep = async (ctx) => {
      let stopTurn = false;
      for (const hook of afterSteps) {
        const result = await hook(ctx);
        if (result?.stopTurn === true) stopTurn = true;
      }
      return stopTurn ? { stopTurn: true } : undefined;
    };
  }

  if (beforeModelRequests.length > 0) {
    composed.beforeModelRequest = async (ctx) => {
      let request = ctx.request;
      let merged: BeforeModelRequestResult | undefined;
      for (const hook of beforeModelRequests) {
        const result = await hook({ ...ctx, request });
        if (!result) continue;
        if (result.block === true) return result;
        if (result.request !== undefined) {
          request = result.request;
          merged = { ...merged, request };
        }
      }
      return merged;
    };
  }

  if (afterModelResponses.length > 0) {
    composed.afterModelResponse = chainModelResponses(afterModelResponses);
  }

  if (prepares.length > 0) {
    composed.prepareToolExecution = async (ctx) => {
      let merged: PrepareToolExecutionResult | undefined;
      let args = ctx.args;
      for (const hook of prepares) {
        const result = await hook({ ...ctx, args });
        if (!result) continue;
        if (result.syntheticResult || result.block === true) return result;
        if (result.updatedArgs !== undefined) {
          args = result.updatedArgs;
          merged = { ...merged, updatedArgs: args };
        }
      }
      return merged;
    };
  }

  if (authorizers.length > 0) {
    composed.authorizeToolExecution = async (ctx) => {
      for (const hook of authorizers) {
        const result: AuthorizeToolExecutionResult | undefined = await hook(ctx);
        if (result) return result;
      }
      return undefined;
    };
  }

  if (finalizers.length > 0) {
    composed.finalizeToolResult = chainFinalizers(finalizers);
  }

  if (continuers.length > 0) {
    composed.shouldContinueAfterStop = async (ctx) => {
      let cont = false;
      for (const hook of continuers) {
        const result = await hook(ctx);
        if (result?.continue === true) cont = true;
      }
      return cont ? { continue: true } : undefined;
    };
  }

  if (recoverers.length > 0) {
    // First claim wins (like `authorizeToolExecution`): the claimant has already acted on the
    // failure (e.g. compacted), so consulting later hooks would recover the same error twice.
    composed.recoverStepError = async (ctx) => {
      for (const hook of recoverers) {
        const result = await hook(ctx);
        if (result?.recovered === true) return result;
      }
      return undefined;
    };
  }

  return composed;
}

function chainModelResponses(hooks: readonly AfterModelResponseHook[]): AfterModelResponseHook {
  return async (ctx) => {
    let response = ctx.response;
    let changed = false;
    for (const hook of hooks) {
      const next = await hook({ ...ctx, response });
      if (next !== undefined) {
        response = next;
        changed = true;
      }
    }
    return changed ? response : undefined;
  };
}

function chainFinalizers(finalizers: readonly FinalizeToolResultHook[]): FinalizeToolResultHook {
  return async (ctx) => {
    let result: ToolResult = ctx.result;
    for (const hook of finalizers) {
      const next = await hook({ ...ctx, result });
      if (next) result = next;
    }
    return result;
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
