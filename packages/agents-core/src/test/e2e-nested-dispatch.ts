/**
 * `ToolRunContext.dispatch` — a running tool calling other tools as NESTED calls through the
 * batch pipeline itself. This is the one piece of Code Mode that lives in the engine: the
 * program's `tools.X()` becomes `dispatch.call("X", …)`, and what that call faces (hooks,
 * authorization, scheduling, events) is pinned here without any program in sight.
 */
import { z } from "zod";
import type { AgentEventBody } from "../events/events.ts";
import { runCalls, type ToolCallStepContext } from "../loop/tool-call.ts";
import type { LoopHooks } from "../loop/types.ts";
import { ToolAccesses } from "../tool/access.ts";
import { tool } from "../tool/define.ts";
import { NullMachine } from "../tool/machine-null.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import { registerFauxProvider } from "./faux.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result: ToolResult): string => result.content.filter((p) => p.type === "text").map((p) => p.text).join("");

/** A tool that overlaps with itself only if the scheduler lets it: records the peak concurrency. */
function overlapProbe(name: string, accesses: ToolAccesses): { tool: Tool; peak: () => number } {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    tool: tool({
      name,
      description: name,
      parameters: z.object({}),
      accesses,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(40);
        active -= 1;
        return "ok";
      },
    }),
  };
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const inner = tool({ name: "Inner", description: "inner", parameters: z.object({ x: z.number() }), execute: (args) => `inner:${String(args.x)}` });
  const suspender = tool({
    name: "Suspender",
    description: "asks",
    parameters: z.object({}),
    execute: (_args, ctx) => ctx.suspend({ kind: "question" }),
  });
  const writer = overlapProbe("Writer", ToolAccesses.writeFile("/x"));
  const reader = overlapProbe("Reader", ToolAccesses.readFile("/x"));
  /** The tool under test: dispatches whatever it is told to, in parallel when asked. */
  const outer = tool({
    name: "Outer",
    description: "outer",
    parameters: z.object({ calls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })) }),
    execute: async (args, ctx) => {
      const dispatch = ctx.dispatch;
      if (dispatch === undefined) return { content: [{ type: "text", text: "no dispatch" }], isError: true };
      const results = await Promise.all(args.calls.map((call) => dispatch.call(call.name, call.args ?? {})));
      return {
        content: [{ type: "text", text: results.map((r) => `${r.isError === true ? "ERR " : ""}${text(r)}`).join("\n") }],
        details: { schemas: dispatch.schemas.map((s) => s.name) },
      };
    },
  });
  const tools = new Map<string, Tool>([
    ["Inner", inner],
    ["Suspender", suspender],
    ["Writer", writer.tool],
    ["Reader", reader.tool],
    ["Outer", outer],
  ]);

  const run = async (calls: Array<{ name: string; args?: Record<string, unknown> }>, hooks?: Partial<LoopHooks>) => {
    const events: AgentEventBody[] = [];
    const step: ToolCallStepContext = {
      turnId: "t1",
      stepNumber: 1,
      signal: new AbortController().signal,
      model: faux.getChatModel(),
      machine: new NullMachine(),
      tools,
      hooks: hooks as LoopHooks | undefined,
      dispatchEvent: (event) => events.push(event),
    };
    const batch = await runCalls(step, [{ type: "toolCall", id: "call_1", name: "Outer", arguments: { calls } }]);
    return { batch, events, result: batch.results[0] };
  };

  // ── the happy path ──
  {
    const { batch, events, result } = await run([{ name: "Inner", args: { x: 7 } }]);
    check("a nested call runs the target tool and hands back its result", result !== undefined && text(result) === "inner:7" && result.isError === false);
    const started = events.find((e) => e.type === "tool.call.started" && e.parentToolCallId === "call_1");
    const ended = events.find((e) => e.type === "tool.result" && e.parentToolCallId === "call_1");
    check("its events carry the parent id and a derived call id", started?.type === "tool.call.started" && started.toolCallId === "call_1:code:1" && started.toolName === "Inner" && ended?.type === "tool.result" && ended.toolCallId === "call_1:code:1");
    check("the parent's own events are unmarked", events.some((e) => e.type === "tool.call.started" && e.toolCallId === "call_1" && e.parentToolCallId === undefined));
    check("dispatch.schemas is the step's whole registry", JSON.stringify((result?.details as { schemas: string[] }).schemas.sort()) === JSON.stringify(["Inner", "Outer", "Reader", "Suspender", "Writer"]));
    check("nothing about the batch is pending", batch.pending === undefined && batch.suspensions === undefined);
  }

  // ── what a nested call cannot do ──
  {
    const { result } = await run([{ name: "Nope" }]);
    check("an unknown tool is an error result, not a throw", result !== undefined && text(result).startsWith("ERR unknown tool: Nope"));
  }
  {
    const { result, batch } = await run([{ name: "Inner", args: { x: "not a number" } }]);
    check("invalid arguments are an error result from the tool's own validation", result !== undefined && text(result).startsWith("ERR ") && batch.pending === undefined);
  }
  {
    const { result, batch, events } = await run([{ name: "Suspender" }]);
    check("a tool that suspends for input fails the nested call instead of pausing the run", result !== undefined && text(result).includes("suspended for the user's input") && batch.pending === undefined && batch.suspensions === undefined);
    check("…and no tool.suspended event is emitted for it", !events.some((e) => e.type === "tool.suspended"));
  }
  {
    const authorized: string[] = [];
    const { result, batch } = await run([{ name: "Inner", args: { x: 1 } }], {
      authorizeToolExecution: async (ctx) => {
        authorized.push(ctx.toolCall.id);
        if (ctx.toolCall.name !== "Inner") return undefined;
        return { interrupt: { kind: "approval", toolCallId: ctx.toolCall.id, toolName: ctx.toolCall.name, approvalRule: "Inner" } };
      },
    });
    check("the authorize hook sees the nested call", authorized.includes("call_1:code:1") && authorized.includes("call_1"));
    check("an approval interrupt on a nested call becomes an error result; the batch does not pause", result !== undefined && text(result).includes("requires the user's approval") && batch.pending === undefined);
  }
  {
    const seen: string[] = [];
    const { result } = await run([{ name: "Inner", args: { x: 2 } }], {
      authorizeToolExecution: async (ctx) => (ctx.toolCall.name === "Inner" ? { block: true, reason: "denied by policy" } : undefined),
      finalizeToolResult: async (ctx) => {
        seen.push(ctx.toolCall.id);
        return undefined;
      },
    });
    check("a blocked nested call carries the policy's reason", result !== undefined && text(result) === "ERR denied by policy");
    check("the finalize hook runs for nested calls that executed (the parent here)", seen.includes("call_1"));
  }

  // ── scheduling: nested calls obey the batch's conflict rule ──
  {
    await run([{ name: "Writer" }, { name: "Writer" }, { name: "Writer" }]);
    await run([{ name: "Reader" }, { name: "Reader" }, { name: "Reader" }]);
    check("conflicting nested calls (write/write) run one at a time", writer.peak() === 1);
    check("compatible nested calls (read/read) overlap", reader.peak() === 3);
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ NESTED DISPATCH E2E PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
