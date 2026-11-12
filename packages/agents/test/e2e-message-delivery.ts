/**
 * What `prompt`, `steer` and `followUp` promise: `prompt` returns its run's result, `followUp` is
 * the same delivery without waiting for it, and each run's answer stays its own.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  createHarness,
  defineAgent,
  HarnessConfigError,
  SessionClosedError,
  SessionInterruptedError,
  SteerTargetNotFoundError,
  type AgentEvent,
  type ExtensionDefinition,
  type HarnessSession,
  type Tool,
} from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
}

function throwsAs(name: string, fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return (error as Error).name === name;
  }
}

/** A session whose next model call can be held open, so messages can arrive mid-run. */
async function holdableSession(answers: readonly string[], agentOf?: (model: ReturnType<ReturnType<typeof registerFauxProvider>["getChatModel"]>) => ReturnType<typeof defineAgent>) {
  const faux = registerFauxProvider();
  faux.setResponses(answers.map((text) => fauxAssistantMessage(text, { stopReason: "stop" })));
  let gate: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  const gating: ExtensionDefinition = {
    id: "gate",
    session(api) {
      api.on("model.request", async () => {
        const current = gate;
        if (current === undefined) return;
        gate = undefined;
        current.entered.resolve();
        await current.release.promise;
      });
    },
  };
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [gating],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession(agentOf !== undefined ? { bindings: { agent: agentOf(faux.getChatModel()) } } : {});
  const events: AgentEvent[] = [];
  session.onEvent((event) => void events.push(event));
  const hold = (): { entered: Promise<void>; release: () => void } => {
    const next = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    gate = next;
    return { entered: next.entered.promise, release: () => next.release.resolve() };
  };
  const said = (role: "user" | "assistant"): string[] =>
    events.flatMap((event) => (event.type === "message.appended" && event.message.role === role ? [textOf(event.message.content)] : []));
  const finish = async (): Promise<void> => {
    await session.close();
    await harness.close();
    faux.unregister();
  };
  return { session: session as HarnessSession, events, hold, said, finish };
}

async function idleFollowUpStartsARun(): Promise<void> {
  const { session, said, finish } = await holdableSession(["answered"]);
  const receipt = session.followUp("while idle");
  await until(() => said("assistant").includes("answered"));
  check("idle follow-up: accepted with a receipt", typeof receipt.steerId === "string");
  check("idle follow-up: starts a run of its own", said("user").some((text) => text.includes("while idle")) && said("assistant").includes("answered"));
  await finish();
}

async function followUpKeepsTheRunsAnswer(): Promise<void> {
  const { session, events, hold, said, finish } = await holdableSession(["answer to A", "answer to B"]);
  const gate = hold();
  const running = session.prompt("A");
  await gate.entered;
  session.followUp("B");
  gate.release();
  const result = await running;
  await until(() => said("assistant").includes("answer to B"));
  check("follow-up: the run keeps its own answer", result.status === "completed" && result.output === "answer to A");
  check("follow-up: gets its own run", events.filter((event) => event.type === "agent.started").length === 2);
  await finish();
}

async function arrivalOrderHolds(): Promise<void> {
  const { session, hold, said, finish } = await holdableSession(["1", "2", "3", "4"]);
  const gate = hold();
  const running = session.prompt("prompt-A");
  await gate.entered;
  session.followUp("follow-1");
  const queued = session.prompt("prompt-B");
  session.followUp("follow-2");
  gate.release();
  await Promise.all([running, queued]);
  await until(() => said("assistant").length === 4);
  const order = said("user").filter((text) => !text.includes("<system-reminder>")).map((text) => ["prompt-A", "follow-1", "prompt-B", "follow-2"].find((name) => text.includes(name)));
  check("order: prompts and follow-ups run as they arrived", order.join(",") === "prompt-A,follow-1,prompt-B,follow-2");
  await finish();
}

async function refusalsAreTyped(): Promise<void> {
  const { session, finish } = await holdableSession([]);
  check("steerTo: an empty address is a typed refusal", throwsAs("SteerTargetNotFoundError", () => session.steerTo("main/nobody", "hi", { kind: "user" })));
  await session.close();
  check("closed: steer refuses", throwsAs(SessionClosedError.name, () => session.steer("x")));
  check("closed: followUp refuses", throwsAs(SessionClosedError.name, () => session.followUp("x")));
  check("closed: steerTo refuses", throwsAs(SessionClosedError.name, () => session.steerTo("main", "x", { kind: "user" })));
  check("closed: prompt rejects", await session.prompt("x").then(() => false, (error: Error) => error instanceof SessionClosedError));
  void SteerTargetNotFoundError;
  await finish();

  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("Bash", { command: "touch .probe && echo hi" }), { stopReason: "toolUse" })]);
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
  });
  const paused = await harness.createSession();
  const result = await paused.prompt("run it");
  check("interrupted: the run stopped for approval", result.status === "interrupted");
  check("interrupted: steer refuses", throwsAs(SessionInterruptedError.name, () => paused.steer("x")));
  check("interrupted: followUp refuses", throwsAs(SessionInterruptedError.name, () => paused.followUp("x")));
  check("interrupted: prompt rejects", await paused.prompt("x").then(() => false, (error: Error) => error instanceof SessionInterruptedError));
  await paused.close();
  await harness.close();
  faux.unregister();
}

async function guardrailsCoverQueuedMessages(): Promise<void> {
  const refuseForbidden = {
    name: "no-forbidden",
    execute: ({ input }: { input: unknown }) => ({ tripwireTriggered: JSON.stringify(input).includes("forbidden") }),
  };
  const { session, events, hold, said, finish } = await holdableSession(["kept going"], (model) =>
    defineAgent({ name: "guarded", model, instructions: "x", guardrails: { input: [refuseForbidden] } }) as never,
  );
  const gate = hold();
  const running = session.prompt("allowed");
  await gate.entered;
  session.steer("forbidden words");
  gate.release();
  const result = await running;
  check("guardrail: a refused steer does not stop the run", result.status === "completed" && result.output === "kept going");
  check("guardrail: the model never saw it", !said("user").some((text) => text.includes("forbidden")));
  check("guardrail: the refusal is reported", events.some((event) => event.type === "guardrail.blocked"));
  check("guardrail: the queued message is closed", events.some((event) => event.type === "steer.discarded" && event.reason === "guardrail"));
  await finish();
}

async function cancelDropsWhatTheUserQueued(): Promise<void> {
  const { session, events, hold, said, finish } = await holdableSession(["never finished", "must not run"]);
  const gate = hold();
  const running = session.prompt("A");
  await gate.entered;
  session.followUp("queued follow-up");
  session.steer("queued steer");
  session.cancel();
  gate.release();
  const result = await running;
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("cancel: the run aborts", result.status === "aborted");
  check("cancel: both queued messages are dropped", events.filter((event) => event.type === "steer.discarded" && event.reason === "cancelled").length === 2);
  check("cancel: nothing queued runs afterwards", events.filter((event) => event.type === "agent.started").length === 1 && !said("user").some((text) => text.includes("queued")));
  await finish();
}

async function harnessDefaultsAndConflicts(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "complete", model, instructions: "x" });
  const tools: readonly Tool[] = [];
  const plain = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await plain.createSession();
  check("permission: defaults to workspace", session.permissionMode === "workspace");
  check("agent conflict: a session's agent refuses its default-agent options", await plain.createSession({
    bindings: { agent: agent, tools: tools }
  }).then(() => false, (error: Error) => error instanceof HarnessConfigError && error.message.includes("tools")));
  check("agent conflict: a harness's agent refuses them at construction", throwsAs(HarnessConfigError.name, () => createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults, agent: "default", appendSystemPrompt: "more" } },
    registry: { agents: { default: agent } }
  })));
  const withAgent = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults, agent: "default" } },
    registry: { agents: { default: agent } }
  });
  check("agent conflict: a harness's agent refuses them on a session", await withAgent.createSession({
    config: { modelSettings: { maxTokens: 10 } }
  }).then(() => false, (error: Error) => error instanceof HarnessConfigError));
  await session.close();
  await plain.close();
  await withAgent.close();
  faux.unregister();
}

await idleFollowUpStartsARun();
await followUpKeepsTheRunsAnswer();
await arrivalOrderHolds();
await refusalsAreTyped();
await guardrailsCoverQueuedMessages();
await cancelDropsWhatTheUserQueued();
await harnessDefaultsAndConflicts();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
