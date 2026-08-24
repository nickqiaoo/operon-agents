/**
 * Unit-style coverage for agent/compose-hooks.ts (composeLoopHooks) — previously zero
 * direct test coverage despite being the merge semantics every capability's LoopHooks
 * contribution goes through. Only ever exercised indirectly via full Runner runs, which
 * never pin down the multi-hook interaction rules precisely. Covers, per hook kind:
 *  - beforeStep: first `block:true` short-circuits later hooks.
 *  - afterStep / shouldContinueAfterStop: "any hook truthy wins", but every hook still runs.
 *  - prepareToolExecution: updatedArgs accumulates and is visible to the NEXT hook; a
 *    block/syntheticResult short-circuits.
 *  - authorizeToolExecution: first non-undefined result wins, later hooks don't run.
 *  - finalizeToolResult: chains result transforms in order; a hook returning undefined
 *    passes the previous result through unchanged.
 *  - composed keys are omitted entirely when no part contributes that hook (not a no-op fn).
 */
import { composeLoopHooks } from "../index.ts";
import type {
  AfterStepContext,
  AuthorizeToolExecutionResult,
  ContextStepHookContext,
  FinalizeToolResultContext,
  LoopHooks,
  ResolvedToolExecutionHookContext,
  StoppedStepContext,
  ToolExecutionHookContext,
} from "../loop/types.ts";
import type { ToolResult } from "../tool/types.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const baseStepCtx = { turnId: "t1", stepNumber: 1, signal: new AbortController().signal, model: {} } as unknown;

async function main(): Promise<void> {
  // ── beforeStep: first block:true short-circuits ──
  {
    const calls: number[] = [];
    const parts: Partial<LoopHooks>[] = [
      { beforeStep: async () => { calls.push(1); return undefined; } },
      { beforeStep: async () => { calls.push(2); return { block: true, reason: "nope" }; } },
      { beforeStep: async () => { calls.push(3); return undefined; } },
    ];
    const composed = composeLoopHooks(parts);
    const result = await composed.beforeStep!(baseStepCtx as ContextStepHookContext);
    check("beforeStep: returns the first block:true result", result?.block === true && result.reason === "nope");
    check("beforeStep: later hooks do not run after a block", !calls.includes(3));
    check("beforeStep: earlier hooks did run", calls.includes(1) && calls.includes(2));
  }

  // ── afterStep: any stopTurn:true wins, but every hook still runs ──
  {
    const calls: number[] = [];
    const parts: Partial<LoopHooks>[] = [
      { afterStep: async () => { calls.push(1); return undefined; } },
      { afterStep: async () => { calls.push(2); return { stopTurn: true }; } },
      { afterStep: async () => { calls.push(3); return undefined; } },
    ];
    const composed = composeLoopHooks(parts);
    const result = await composed.afterStep!(baseStepCtx as AfterStepContext);
    check("afterStep: stopTurn:true from any hook wins", result?.stopTurn === true);
    check("afterStep: every hook still runs (not short-circuited)", calls.length === 3);
  }
  {
    const parts: Partial<LoopHooks>[] = [{ afterStep: async () => undefined }, { afterStep: async () => ({}) }];
    const composed = composeLoopHooks(parts);
    const result = await composed.afterStep!(baseStepCtx as AfterStepContext);
    check("afterStep: no hook requesting stopTurn → undefined (not {stopTurn:false})", result === undefined);
  }

  // ── prepareToolExecution: updatedArgs accumulates and is visible to the next hook ──
  {
    const seenArgs: unknown[] = [];
    const parts: Partial<LoopHooks>[] = [
      {
        prepareToolExecution: async (ctx) => {
          seenArgs.push(ctx.args);
          return { updatedArgs: { a: 1 } };
        },
      },
      {
        prepareToolExecution: async (ctx) => {
          seenArgs.push(ctx.args);
          return { updatedArgs: { ...(ctx.args as object), b: 2 } };
        },
      },
    ];
    const composed = composeLoopHooks(parts);
    const ctx = { ...baseStepCtx, toolCall: {}, args: { original: true } } as ToolExecutionHookContext;
    const result = await composed.prepareToolExecution!(ctx);
    check("prepareToolExecution: first hook sees the original args", (seenArgs[0] as { original?: boolean }).original === true);
    check("prepareToolExecution: second hook sees the FIRST hook's updatedArgs, not the original", (seenArgs[1] as { a?: number }).a === 1);
    check("prepareToolExecution: final updatedArgs reflects both hooks merged", (result?.updatedArgs as { a?: number; b?: number })?.a === 1 && (result?.updatedArgs as { b?: number })?.b === 2);
  }
  {
    const calls: number[] = [];
    const parts: Partial<LoopHooks>[] = [
      { prepareToolExecution: async () => { calls.push(1); return { block: true }; } },
      { prepareToolExecution: async () => { calls.push(2); return undefined; } },
    ];
    const composed = composeLoopHooks(parts);
    const ctx = { ...baseStepCtx, toolCall: {}, args: {} } as ToolExecutionHookContext;
    const result = await composed.prepareToolExecution!(ctx);
    check("prepareToolExecution: block:true short-circuits later hooks", result?.block === true && !calls.includes(2));
  }

  // ── authorizeToolExecution: first non-undefined result wins ──
  {
    const calls: number[] = [];
    const parts: Partial<LoopHooks>[] = [
      { authorizeToolExecution: async () => { calls.push(1); return undefined; } },
      { authorizeToolExecution: async (): Promise<AuthorizeToolExecutionResult | undefined> => { calls.push(2); return { block: true, reason: "denied" }; } },
      { authorizeToolExecution: async () => { calls.push(3); return undefined; } },
    ];
    const composed = composeLoopHooks(parts);
    const ctx = { ...baseStepCtx, toolCall: {}, args: {}, plan: {} } as ResolvedToolExecutionHookContext;
    const result = await composed.authorizeToolExecution!(ctx);
    check("authorizeToolExecution: first non-undefined result wins", result?.block === true && result.reason === "denied");
    check("authorizeToolExecution: later hooks do not run once one answers", !calls.includes(3));
  }

  // ── finalizeToolResult: chains transforms; undefined passes the previous result through ──
  {
    const original: ToolResult = { content: [{ type: "text", text: "base" }] };
    const parts: Partial<LoopHooks>[] = [
      { finalizeToolResult: async (ctx) => ({ content: [{ type: "text", text: `${(ctx.result.content[0] as { text: string }).text}+A` }] }) },
      { finalizeToolResult: async () => undefined },
      { finalizeToolResult: async (ctx) => ({ content: [{ type: "text", text: `${(ctx.result.content[0] as { text: string }).text}+C` }] }) },
    ];
    const composed = composeLoopHooks(parts);
    const ctx = { ...baseStepCtx, toolCall: {}, args: {}, result: original } as FinalizeToolResultContext;
    const result = await composed.finalizeToolResult!(ctx);
    check(
      "finalizeToolResult: transforms chain in order, undefined passes the prior result through",
      (result?.content[0] as { text: string })?.text === "base+A+C",
    );
  }

  // ── shouldContinueAfterStop: any continue:true wins ──
  {
    const parts: Partial<LoopHooks>[] = [{ shouldContinueAfterStop: async () => undefined }, { shouldContinueAfterStop: async () => ({ continue: true }) }];
    const composed = composeLoopHooks(parts);
    const result = await composed.shouldContinueAfterStop!(baseStepCtx as StoppedStepContext);
    check("shouldContinueAfterStop: continue:true from any hook wins", result?.continue === true);
  }

  // ── omitted keys: a hook kind with zero contributors is absent, not a no-op function ──
  {
    const composed = composeLoopHooks([{ beforeStep: async () => undefined }, undefined]);
    check("composed: beforeStep is present when contributed", typeof composed.beforeStep === "function");
    check("composed: afterStep is OMITTED (undefined) when no part contributes it", composed.afterStep === undefined);
    check("composed: authorizeToolExecution is OMITTED when no part contributes it", composed.authorizeToolExecution === undefined);
    check("composed: undefined entries in the parts array are tolerated", composeLoopHooks([undefined, undefined]).beforeStep === undefined);
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — composeLoopHooks merge semantics");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
