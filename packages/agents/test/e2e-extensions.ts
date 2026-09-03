import { T } from "operon-agents-core";
import { testRunner, openTestSession } from "operon-agents-core/internal";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  BoundaryInjector,
  compactionCapability,
  createHarness,
  defineAgent,
  extensionsCapability,
  ListenerSink,
  LocalMachine,
  MemoryStore,
  Runner,
  Session,
  tool,
  type AgentEvent,
  type AgentRecord,
  type Capability,
  type LlmRequest,
  type ExtensionDefinition,
  type InjectionContext,
  type InjectionResult,
  type Message,
} from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(messages: readonly Message[], role: Message["role"]): string {
  return messages
    .filter((message) => message.role === role)
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

async function readRecords(store: MemoryStore): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of store.readRecords()) out.push(record);
  return out;
}

class ProbeInjector extends BoundaryInjector {
  readonly id = "extension_probe";
  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    if (this.restoreInjectedAt(ctx)) return null;
    return { text: "INJECTED_BY_EXTENSION", variant: "probe" };
  }
}

/** Decision points + actions + injector registration, over one two-step run. */
async function coreSurface(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ExtensionEcho", { value: "before" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const events = new ListenerSink();
  const observed: AgentEvent[] = [];
  events.subscribe((event) => observed.push(event));
  const store = new MemoryStore();

  const seen = {
    sessionStart: 0,
    stepStart: 0,
    stepEnd: 0,
    runSettled: 0,
    modelRequest: 0,
    modelResponse: 0,
    toolCall: 0,
    toolAuthorize: 0,
    toolResult: 0,
  };
  let sawContextOnModelRequest = false;
  let sawPlanOnAuthorize = false;
  let contextUsageTokens: number | undefined;

  const extension: ExtensionDefinition = {
    id: "surface-extension",
    setup(api) {
      api.registerTool(tool({
        name: "ExtensionEcho",
        description: "Echo a value.",
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => `executed:${value}`,
      }));
      api.registerInjector(new ProbeInjector());
      api.on("session.start", async ({ state, reason }) => {
        seen.sessionStart += 1;
        await state.set("opened", reason);
      });
      api.on("step.start", ({ actions, stepNumber }) => {
        seen.stepStart += 1;
        if (stepNumber === 1) actions.record("step-began", { stepNumber });
      });
      api.on("step.end", ({ actions }) => {
        seen.stepEnd += 1;
        contextUsageTokens = actions.getContextUsage()?.used;
      });
      api.on("run.settled", () => {
        seen.runSettled += 1;
      });
      api.on("model.request", ({ request, context }) => {
        seen.modelRequest += 1;
        if (context.messages.length > 0) sawContextOnModelRequest = true;
        return { request };
      });
      api.on("model.response", ({ response }) => {
        seen.modelResponse += 1;
        return response;
      });
      api.on("tool.call", ({ args }) => {
        seen.toolCall += 1;
        return { updatedArgs: { ...(args as object), value: "after" } };
      });
      api.on("tool.authorize", ({ plan }) => {
        seen.toolAuthorize += 1;
        if (plan !== undefined) sawPlanOnAuthorize = true;
      });
      api.on("tool.result", ({ result }) => {
        seen.toolResult += 1;
        return { ...result, details: { extensionObserved: true } };
      });
    },
  };

  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "extension-test", model, instructions: "x" });
  const result = await testRunner({
    machine: new LocalMachine(process.cwd()),
    store,
    events,
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  }).run(agent, "go");

  const toolMessage = result.messages.find(
    (message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult",
  );
  const toolText = toolMessage?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
  const records = await readRecords(store);

  check("session.start fires once with a reason", seen.sessionStart === 1 && (await store.getState("extension:surface-extension:opened")) === "open");
  check("registered tool executes with transformed args", toolText === "executed:after");
  check("tool.call / tool.authorize / tool.result each fire once", seen.toolCall === 1 && seen.toolAuthorize === 1 && seen.toolResult === 1);
  check("tool.authorize receives the resolved plan", sawPlanOnAuthorize);
  check("tool.result transform reaches the journaled message", (toolMessage?.details as { extensionObserved?: boolean } | undefined)?.extensionObserved === true);
  check("model.request / model.response cover every step", seen.modelRequest === 2 && seen.modelResponse === 2);
  check("model.request carries the live conversation", sawContextOnModelRequest);
  check("step.start / step.end cover every step", seen.stepStart === 2 && seen.stepEnd === 2);
  check("run.settled fires at the terminal stop", seen.runSettled === 1);
  check("actions.record journals a namespaced custom record", records.some((r) => r.type === "custom" && r.name === "extension:surface-extension:step-began"));
  check("actions.getContextUsage returns a breakdown", typeof contextUsageTokens === "number" && contextUsageTokens > 0);
  check("registerInjector reaches the turn boundary", textOf(result.messages, "user").includes("INJECTED_BY_EXTENSION"));
  check("events still stream to plain sink subscribers", observed.some((event) => event.type === "agent.started"));

  faux.unregister();
}

/** tool.authorize blocks; run.settled forces exactly one extra turn; actions.steer lands in-turn. */
async function interventions(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Guarded", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("first", { stopReason: "stop" }),
    fauxAssistantMessage("second", { stopReason: "stop" }),
  ]);
  const events = new ListenerSink();
  const model = faux.getChatModel()!;
  let continued = false;
  let steered = false;

  const extension: ExtensionDefinition = {
    id: "intervention-extension",
    setup(api) {
      api.registerTool(tool({
        name: "Guarded",
        description: "Should never run.",
        parameters: z.object({}),
        execute: () => "SHOULD_NOT_RUN",
      }));
      api.on("tool.authorize", () => ({ block: true, reason: "denied by extension" }));
      api.on("step.end", ({ actions, stepNumber }) => {
        if (stepNumber === 1 && !steered) {
          steered = true;
          actions.steer("STEERED_BY_EXTENSION");
        }
      });
      api.on("run.settled", () => {
        if (continued) return undefined;
        continued = true;
        return { continue: true };
      });
    },
  };

  const agent = defineAgent({ name: "intervention-test", model, instructions: "x" });
  const result = await testRunner({
    machine: new LocalMachine(process.cwd()),
    events,
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  }).run(agent, "go");

  const toolText = textOf(result.messages.filter((m) => m.role === "toolResult"), "toolResult");
  check("tool.authorize block prevents execution", !toolText.includes("SHOULD_NOT_RUN") && toolText.includes("denied by extension"));
  check("actions.steer lands in the conversation", textOf(result.messages, "user").includes("STEERED_BY_EXTENSION"));
  check("run.settled continue forces one more turn", result.messages.filter((m) => m.role === "assistant").length >= 3);

  faux.unregister();
}

/** Run-tier input rewrite, step-local system prompt, and blocking terminate. */
async function runTierHooks(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("only", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  let observedSystem: string | undefined;

  const extension: ExtensionDefinition = {
    id: "run-tier-extension",
    setup(api) {
      api.on("run.start", ({ input, agent }) => ({
        input: [...input, { role: "user", content: [{ type: "text", text: `REWRITTEN_FOR_${agent}` }], timestamp: Date.now() }],
      }));
      api.on("step.start", () => ({ system: "SYSTEM_FROM_EXTENSION" }));
      api.on("model.request", ({ request }) => {
        observedSystem = request.system;
        return undefined;
      });
    },
  };

  const agent = defineAgent({ name: "run-tier", model, instructions: "ORIGINAL_SYSTEM" });
  const result = await testRunner({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  }).run(agent, "go");

  check("run.start rewrites the input before it is journaled", textOf(result.messages, "user").includes("REWRITTEN_FOR_run-tier"));
  check("step.start replaces the system prompt for the request", observedSystem === "SYSTEM_FROM_EXTENSION");

  faux.unregister();

  // terminate: a blocked call ends the turn instead of feeding the denial back to the model.
  const faux2 = registerFauxProvider();
  faux2.setResponses([
    fauxAssistantMessage(fauxToolCall("Stopper", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("MODEL_REACTED_TO_DENIAL", { stopReason: "stop" }),
  ]);
  const model2 = faux2.getChatModel()!;
  const terminating: ExtensionDefinition = {
    id: "terminate-extension",
    setup(api) {
      api.registerTool(tool({ name: "Stopper", description: "x", parameters: z.object({}), execute: () => "ran" }));
      api.on("tool.call", () => ({ block: true, reason: "halted", terminate: true }));
    },
  };
  const stopResult = await testRunner({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([terminating])],
  }).run(defineAgent({ name: "terminate-test", model: model2, instructions: "x" }), "go");

  check("tool.call terminate ends the turn after the denial", !textOf(stopResult.messages, "assistant").includes("MODEL_REACTED_TO_DENIAL"));

  faux2.unregister();
}

/** setActiveTools narrows the registry from the next turn on. */
async function toolGating(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Gated", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("turn one done", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("Gated", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("turn two done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  let allToolsSeen: readonly string[] = [];
  let activeAfterGate: readonly string[] = [];

  const extension: ExtensionDefinition = {
    id: "gating-extension",
    setup(api) {
      api.registerTool(tool({ name: "Gated", description: "x", parameters: z.object({}), execute: () => "GATED_RAN" }));
      api.on("run.settled", ({ actions }) => {
        allToolsSeen = actions.getAllTools();
        // Withhold the tool for any subsequent turn.
        actions.setActiveTools(allToolsSeen.filter((name) => name !== "Gated"));
        activeAfterGate = actions.getActiveTools();
        return undefined;
      });
    },
  };

  const session = await openTestSession({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  });
  const runner = testRunner({});
  const agent = defineAgent({ name: "gating", model, instructions: "x" });
  const first = await runner.run(agent, "go", { session });
  const second = await runner.run(agent, "again", { session });
  await session.close();

  check("getAllTools reports the assembled registry", allToolsSeen.includes("Gated"));
  check("setActiveTools is reflected by getActiveTools", !activeAfterGate.includes("Gated"));
  // Same session: `second.messages` replays the first run too, so compare only what run two added.
  const secondOnly = second.messages.slice(first.messages.length);
  check("turn one ran the tool", textOf(first.messages.filter((m) => m.role === "toolResult"), "toolResult").includes("GATED_RAN"));
  check(
    "the withheld tool is gone from the next run",
    !textOf(secondOnly.filter((m) => m.role === "toolResult"), "toolResult").includes("GATED_RAN")
      && textOf(secondOnly.filter((m) => m.role === "toolResult"), "toolResult").includes("unknown tool: Gated"),
  );

  faux.unregister();
}

/** actions.abort stops the run it fires in, and leaves the session usable. */
async function abortControl(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Trigger", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("SHOULD_NOT_REACH", { stopReason: "stop" }),
    fauxAssistantMessage("second run fine", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  let aborts = 0;

  const extension: ExtensionDefinition = {
    id: "abort-extension",
    setup(api) {
      api.registerTool(tool({ name: "Trigger", description: "x", parameters: z.object({}), execute: () => "ran" }));
      api.on("tool.result", ({ actions }) => {
        if (aborts === 0) {
          aborts += 1;
          actions.abort("extension decided to stop");
        }
        return undefined;
      });
    },
  };

  const session = await openTestSession({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  });
  const runner = testRunner({});
  const agent = defineAgent({ name: "abort-test", model, instructions: "x" });

  const aborted = await runner.run(agent, "go", { session });
  check("actions.abort settles the run as aborted", aborted.status === "aborted");
  check("actions.abort stops before the next model step", !textOf(aborted.messages, "assistant").includes("SHOULD_NOT_REACH"));

  // The session must survive: a per-run abort is not a session kill.
  const after = await runner.run(agent, "again", { session });
  check("the session stays usable after a run-scoped abort", after.status === "completed");
  check("session.signal is untouched by a run-scoped abort", !session.signal.aborted);

  // Session-level abort is the bigger hammer. Starting a run on an already-cancelled session
  // rejects rather than settling — matching what an already-aborted caller signal has always done.
  session.abort("done with this session");
  let rejected: unknown;
  await runner.run(agent, "third", { session }).catch((error: unknown) => {
    rejected = error;
  });
  check(
    "session.abort makes subsequent runs reject as AbortError",
    rejected instanceof Error && rejected.name === "AbortError" && rejected.message === "done with this session",
  );
  check("session.abort marks the session signal", session.signal.aborted);

  await session.close();
  faux.unregister();
}

/** A tool name already owned by the agent must not be hijacked by an extension. */
async function collision(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Collision", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("collision done", { stopReason: "stop" }),
  ]);
  const events = new ListenerSink();
  const warnings: string[] = [];
  events.subscribe((event) => {
    if (event.type === "warning") warnings.push(event.message);
  });
  const model = faux.getChatModel()!;
  const ownTool = tool({ name: "Collision", description: "agent-owned", parameters: z.object({}), execute: () => "agent-tool" });
  const agent = defineAgent({ name: "collision", model, instructions: "x", tools: [ownTool] });
  const extension: ExtensionDefinition = {
    id: "collision-extension",
    setup(api) {
      api.registerTool(tool({ name: "Collision", description: "extension-owned", parameters: z.object({}), execute: () => "extension-tool" }));
    },
  };
  const result = await testRunner({
    machine: new LocalMachine(process.cwd()),
    events,
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  }).run(agent, "go");

  const text = textOf(result.messages.filter((m) => m.role === "toolResult"), "toolResult");
  check("tool collision fails closed to the agent's own tool", text === "agent-tool");
  check("tool collision emits a diagnostic", warnings.some((w) => w.includes("collision-extension") && w.includes("Collision")));

  faux.unregister();
}

/** The harness-tier reach: sessions from inside an extension, idle probes, provider registry. */
async function hostReach(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("main run", { stopReason: "stop" }),
    fauxAssistantMessage("spawned run", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;

  let forkedId: string | undefined;
  let spawnedOutput: string | undefined;
  let sessionCount = 0;
  let idleDuringRun: boolean | undefined;
  let providerRegistered = false;
  let hostSessionId: string | undefined;

  const extension: ExtensionDefinition = {
    id: "host-extension",
    setup(api) {
      api.on("run.settled", async ({ actions }) => {
        idleDuringRun = actions.isIdle();
        const forked = await actions.fork({ title: "forked-by-extension" });
        forkedId = forked.id;
        const spawned = await forked.prompt("go");
        spawnedOutput = spawned.output;
        sessionCount = (await actions.listSessions()).length;
        await forked.close();
        return undefined;
      });
      api.on("session.start", ({ actions }) => {
        try {
          actions.registerProvider({ id: "probe-provider", api: "anthropic-messages", models: [] } as never);
          providerRegistered = true;
        } catch {
          providerRegistered = false;
        }
      });
    },
  };

  const harness = createHarness({
    model,
    harness: (s) => s.register(T.ModelRuntime, faux.runtime, { owned: false }),
    workDir: process.cwd(),
    permission: { mode: "yolo" },
    extensions: [extension],
  });
  const session = await harness.createSession();
  hostSessionId = session.id;
  const result = await session.prompt("hello");

  check("host: the main run completes normally", result.status === "completed" && result.output.includes("main run"));
  check("host: fork() created a different session", typeof forkedId === "string" && forkedId !== hostSessionId);
  check("host: the forked session can be prompted", spawnedOutput?.includes("spawned run") === true);
  check("host: listSessions sees both", sessionCount >= 2);
  check("host: isIdle is false while the run that called it is in flight", idleDuringRun === false);
  check("host: registerProvider reaches the model runtime", providerRegistered && faux.runtime.models.getProvider("probe-provider") !== undefined);

  await harness.close();
  faux.unregister();
}

/**
 * Provider-tier hooks. `transformHeaders` runs in pi-ai's Models layer, so the faux provider
 * exercises it end to end. `onPayload`/`onResponse` are invoked by real api implementations
 * (anthropic-messages, openai-responses, …) which faux does not run — for those we verify what
 * IS ours: that the callbacks get folded into `providerOptions`, and that the chain composes.
 */
async function providerHooks(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;

  let headersSeen: Record<string, string | null> | undefined;
  let sentRequest: LlmRequest | undefined;

  const first: ExtensionDefinition = {
    id: "provider-ext-a",
    setup(api) {
      api.on("provider.headers", ({ headers }) => {
        headersSeen = headers;
        return { headers: { ...headers, "x-trace": "a" } };
      });
      api.on("provider.payload", ({ payload }) => ({ payload: { ...(payload as object), a: 1 } }));
      api.on("provider.response", () => undefined);
    },
  };
  const second: ExtensionDefinition = {
    id: "provider-ext-b",
    setup(api) {
      // Chains on top of A's rewrite, both for headers and payload.
      api.on("provider.headers", ({ headers }) => ({ headers: { ...headers, "x-trace-b": "b" } }));
      api.on("provider.payload", ({ payload }) => ({ payload: { ...(payload as object), b: 2 } }));
    },
  };

  let chainedHeaders: Record<string, string | null> | undefined;
  let chainedPayload: Record<string, unknown> | undefined;

  // A plain capability registered AFTER the extensions one sees the request it assembled. The
  // callbacks are driven from HERE, in-run, because that is when pi-ai would call them — after
  // the run, `close()` has disposed every handler registration and the chains are empty.
  const probe: Capability = {
    name: "probe",
    hooks: {
      beforeModelRequest: async (ctx) => {
        sentRequest = ctx.request;
        const options = ctx.request.providerOptions as {
          transformHeaders?: (h: Record<string, string | null>) => Promise<Record<string, string | null>>;
          onPayload?: (p: unknown) => Promise<unknown>;
        };
        chainedHeaders = await options.transformHeaders?.({ "x-orig": "keep" });
        chainedPayload = (await options.onPayload?.({ base: true })) as Record<string, unknown>;
        return undefined;
      },
    },
  };

  await testRunner({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([first, second]), probe],
  }).run(defineAgent({ name: "provider-test", model, instructions: "x" }), "go");

  const options = sentRequest?.providerOptions as
    | { transformHeaders?: unknown; onPayload?: unknown; onResponse?: unknown }
    | undefined;

  check("provider hooks are folded into providerOptions", typeof options?.transformHeaders === "function"
    && typeof options?.onPayload === "function" && typeof options?.onResponse === "function");
  check("provider.headers actually ran through pi-ai's Models layer", headersSeen !== undefined);

  check("provider.headers chains both extensions in order",
    chainedHeaders?.["x-orig"] === "keep" && chainedHeaders?.["x-trace"] === "a" && chainedHeaders?.["x-trace-b"] === "b");
  check("provider.payload chains both extensions in order",
    chainedPayload?.base === true && chainedPayload?.a === 1 && chainedPayload?.b === 2);

  faux.unregister();

  // No provider-tier handlers ⇒ extensions add no callbacks. Core may still carry its own
  // session-affinity key in providerOptions for prompt-cache routing.
  const faux2 = registerFauxProvider();
  faux2.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  let bareRequest: LlmRequest | undefined;
  const bareProbe: Capability = {
    name: "bare-probe",
    hooks: {
      beforeModelRequest: async (ctx) => {
        bareRequest = ctx.request;
        return undefined;
      },
    },
  };
  await testRunner({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([{ id: "noop-ext", setup: () => undefined }]), bareProbe],
  }).run(defineAgent({ name: "bare-test", model: faux2.getChatModel()!, instructions: "x" }), "go");

  const bareOptions = bareRequest?.providerOptions;
  check(
    "no provider handlers ⇒ no provider callbacks installed",
    typeof bareOptions?.sessionId === "string"
      && bareOptions.transformHeaders === undefined
      && bareOptions.onPayload === undefined
      && bareOptions.onResponse === undefined,
  );

  faux2.unregister();
}

/** run.start `handled`: the extension answers, the model is never called, nothing is journaled. */
async function handledInput(): Promise<void> {
  const faux = registerFauxProvider();
  // Deliberately one response: if the loop ran at all, the SECOND prompt below would consume it
  // and the assertions would shift.
  faux.setResponses([fauxAssistantMessage("MODEL_RAN", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  let modelRequests = 0;

  const extension: ExtensionDefinition = {
    id: "cache-extension",
    setup(api) {
      api.on("run.start", ({ input }) => {
        const text = textOf(input, "user");
        return text.includes("status") ? { handled: { output: "cached: all good" } } : undefined;
      });
      api.on("model.request", () => {
        modelRequests += 1;
        return undefined;
      });
    },
  };

  const session = await openTestSession({
    machine: new LocalMachine(process.cwd()),
    events: new ListenerSink(),
    permission: { mode: "yolo" },
    capabilities: [extensionsCapability([extension])],
  });
  const runner = testRunner({});
  const agent = defineAgent({ name: "handled-test", model, instructions: "x" });

  const short = await runner.run(agent, "status", { session });
  check("handled run settles as skipped", short.status === "skipped");
  check("handled run carries the extension's output", short.output === "cached: all good");
  check("handled run never calls the model", modelRequests === 0);
  check("handled run journals nothing", short.messages.length === 0);

  // The very next prompt runs normally — `handled` is per-run, not sticky.
  const normal = await runner.run(agent, "anything else", { session });
  check("a non-handled prompt still runs the model", normal.status === "completed" && normal.output.includes("MODEL_RAN"));
  check("the skipped run left no trace in history", normal.messages.filter((m) => m.role === "user").length === 1);

  await session.close();
  faux.unregister();
}

/** compaction.before: cancel vetoes the pass; replacement supplies the summary without a model call. */
async function compactionGate(): Promise<void> {
  // Manual compaction (`session.compact()`) rather than the token threshold: the gate contract is
  // what is under test, and a manual request fires it deterministically without having to stage a
  // context big enough to cross a real threshold.
  const run = async (extension: ExtensionDefinition) => {
    const faux = registerFauxProvider();
    faux.setResponses([
      fauxAssistantMessage("first answer", { stopReason: "stop" }),
      fauxAssistantMessage("second answer", { stopReason: "stop" }),
      fauxAssistantMessage("third answer", { stopReason: "stop" }),
    ]);
    const model = faux.getChatModel()!;
    const session = await openTestSession({
      machine: new LocalMachine(process.cwd()),
      events: new ListenerSink(),
      permission: { mode: "yolo" },
      capabilities: [extensionsCapability([extension]), compactionCapability({ maxContextTokens: 48_000 })],
    });
    const runner = testRunner({});
    const agent = defineAgent({ name: "gate-test", model, instructions: "x" });
    await runner.run(agent, "one", { session });
    await runner.run(agent, "two", { session });
    await session.compact();
    const result = await runner.run(agent, "three", { session });
    await session.close();
    faux.unregister();
    return result;
  };

  let seen: { reason: string; compactCount: number } | undefined;
  const vetoing: ExtensionDefinition = {
    id: "veto-extension",
    setup(api) {
      api.on("compaction.before", ({ reason, compactCount }) => {
        seen = { reason, compactCount };
        return { cancel: true };
      });
    },
  };
  const afterVeto = await run(vetoing);
  check("compaction.before fires with reason + compactCount",
    seen !== undefined && seen.reason === "manual" && seen.compactCount > 0);
  check("compaction.before cancel leaves history uncompacted",
    !allTextOf(afterVeto.messages).includes("<context-summary>"));

  const replacing: ExtensionDefinition = {
    id: "replace-extension",
    setup(api) {
      api.on("compaction.before", () => ({ replacement: { summary: "SUMMARY_FROM_EXTENSION", count: 1 } }));
    },
  };
  const afterReplace = await run(replacing);
  check("compaction.before replacement lands in history",
    allTextOf(afterReplace.messages).includes("SUMMARY_FROM_EXTENSION"));
}

function allTextOf(messages: readonly Message[]): string {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

async function main(): Promise<void> {
  await coreSurface();
  await interventions();
  await runTierHooks();
  await toolGating();
  await abortControl();
  await hostReach();
  await providerHooks();
  await handledInput();
  await compactionGate();
  await collision();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ EXTENSIONS E2E PASS");
}

main().catch((error) => {
  console.error("❌ EXTENSIONS E2E ERROR:", error);
  process.exit(1);
});
