/**
 * Host context reaches tools — `RunOptions.context` arrives as `ctx.context` in both tool phases.
 *
 * The shape this serves is an API-backed agent on a server: no filesystem (`NullEnvironment`),
 * a few tools that call the host's own backend, and the caller's identity in `context`.
 *
 *  A. `tool()` — `execute` sees the run's context, on a session with no environment
 *  B. `defineTool()` — `resolve` sees it too, so a plan (its approval rule) can depend on it
 *  C. a subagent's tools see the root run's context
 *  D. resume — the context is the RESUMING call's, never journaled from the paused one
 *  E. no context — `ctx.context` is absent, not some placeholder
 */
import { strict as assert } from "node:assert";
import { z } from "zod";
import { defineAgent, defineTool, getInterruptionState, MemoryStore, NullEnvironment, Runner, tool } from "../index.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";

interface Caller {
  readonly userId: string;
}

const faux = registerFauxProvider();
const model = faux.getChatModel()!;

const runner = new Runner<Caller>({ session: () => ({ permissionOptions: { mode: "yolo" } }) });

// ── A. tool() execute ────────────────────────────────────────────────────────────
{
  const seen: (Caller | undefined)[] = [];
  let environmentName: string | undefined;
  const getOrder = tool({
    name: "get_order",
    description: "look up an order",
    parameters: z.object({ orderId: z.string() }),
    execute: ({ orderId }, ctx) => {
      seen.push(ctx.context as Caller | undefined);
      environmentName = ctx.environment.name;
      return `order ${orderId} of ${(ctx.context as Caller).userId}`;
    },
  });
  const agent = defineAgent<Caller>({ name: "support", instructions: "x", model, tools: [getOrder] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("get_order", { orderId: "42" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await runner.run(agent, "where is my order", { context: { userId: "alice" } });
  assert.equal(result.status, "completed", `A status: ${result.status}`);
  assert.deepEqual(seen, [{ userId: "alice" }], "A: execute did not see the run's context");
  assert.equal(environmentName, new NullEnvironment().name, "A: expected the no-filesystem environment");
  console.log("A OK — tool() execute sees RunOptions.context on a NullEnvironment session");
}

// ── B. defineTool() resolve + run, and a typed context ───────────────────────────
{
  const rules: string[] = [];
  const runs: string[] = [];
  const refund = defineTool<z.ZodObject<{ amount: z.ZodNumber }>, Caller>({
    name: "refund",
    description: "refund the caller",
    params: z.object({ amount: z.number() }),
    resolve: (args, ctx) => {
      // Typed: `ctx.context` is `Caller | undefined` here, no cast.
      const rule = `refund(${ctx.context?.userId}:${args.amount})`;
      rules.push(rule);
      return {
        approvalRule: rule,
        run: async (runCtx) => {
          runs.push((runCtx.context as Caller).userId);
          return { content: [{ type: "text" as const, text: "refunded" }] };
        },
      };
    },
  });
  const agent = defineAgent<Caller>({ name: "billing", instructions: "x", model, tools: [refund] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("refund", { amount: 5 }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await runner.run(agent, "refund me", { context: { userId: "bob" } });
  assert.equal(result.status, "completed", `B status: ${result.status}`);
  assert.deepEqual(rules, ["refund(bob:5)"], "B: resolve did not see the run's context");
  assert.deepEqual(runs, ["bob"], "B: plan.run did not see the run's context");
  console.log("B OK — defineTool() resolve and run both see the context");
}

// ── C. a subagent's tools ────────────────────────────────────────────────────────
{
  const seen: (Caller | undefined)[] = [];
  const whoami = tool({
    name: "whoami",
    description: "who is calling",
    parameters: z.object({}),
    execute: (_args, ctx) => {
      seen.push(ctx.context as Caller | undefined);
      return "ok";
    },
  });
  const worker = defineAgent<Caller>({ name: "worker", instructions: "x", model, tools: [whoami] });
  const main = defineAgent<Caller>({ name: "main", instructions: "x", model, subagents: [worker] });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall("Agent", { subagent_type: "worker", prompt: "check", description: "check caller" }),
      { stopReason: "toolUse" },
    ),
    () => fauxAssistantMessage(fauxToolCall("whoami", {}), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("worker done", { stopReason: "stop" }),
    () => fauxAssistantMessage("main done", { stopReason: "stop" }),
  ]);
  const result = await runner.run(main, "delegate", { context: { userId: "carol" } });
  assert.equal(result.status, "completed", `C status: ${result.status}`);
  assert.deepEqual(seen, [{ userId: "carol" }], "C: the subagent's tool did not see the root context");
  console.log("C OK — a subagent's tools see the root run's context");
}

// ── D. resume carries the resuming call's context ────────────────────────────────
{
  const seen: string[] = [];
  const confirm = defineTool({
    name: "confirm",
    description: "ask, then act",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "confirm",
      run: async (ctx) => {
        seen.push(`${ctx.resumed ? "resumed" : "first"}:${(ctx.context as Caller | undefined)?.userId}`);
        if (!ctx.resumed) ctx.suspend({ kind: "choice", display: { title: "sure?" } });
        return { content: [{ type: "text" as const, text: "confirmed" }] };
      },
    }),
  });
  const agent = defineAgent<Caller>({ name: "d", instructions: "x", model, tools: [confirm] });
  const store = new MemoryStore();
  const durable = new Runner<Caller>({ session: () => ({ store, permissionOptions: { mode: "yolo" } }) });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("confirm", {}), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const paused = await durable.run(agent, "go", { sessionId: "d", context: { userId: "dave" } });
  assert.equal(paused.status, "interrupted", `D/run status: ${paused.status}`);
  const pending = paused.interruptions![0]!;
  const resumed = await durable.resume(
    agent,
    { interruption: getInterruptionState(paused)!, answers: { [pending.approvalId]: { kind: "input", data: {} } } },
    { sessionId: "d", context: { userId: "erin" } },
  );
  assert.equal(resumed.status, "completed", `D/resume status: ${resumed.status}`);
  assert.deepEqual(seen, ["first:dave", "resumed:erin"], `D: unexpected contexts ${JSON.stringify(seen)}`);
  console.log("D OK — a resumed call sees the resuming run's context, not the paused one's");
}

// ── E. no context ────────────────────────────────────────────────────────────────
{
  let hasKey: boolean | undefined;
  const probe = tool({
    name: "probe",
    description: "probe",
    parameters: z.object({}),
    execute: (_args, ctx) => {
      hasKey = "context" in ctx;
      return "ok";
    },
  });
  const agent = defineAgent({ name: "e", instructions: "x", model, tools: [probe] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await new Runner({ session: () => ({ permissionOptions: { mode: "yolo" } }) }).run(agent, "go");
  assert.equal(result.status, "completed", `E status: ${result.status}`);
  assert.equal(hasKey, false, "E: ctx.context should be absent when the run has no context");
  console.log("E OK — no context, no ctx.context");
}

faux.unregister();
console.log("OK — host context reaches tools");
