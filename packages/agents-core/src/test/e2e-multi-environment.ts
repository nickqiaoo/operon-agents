/**
 * Multi-environment sessions — one agent loop working on several machines.
 *
 *  A. single environment — no `target` on any schema, no environment list in the prompt, no
 *     `environment` on events: the path every existing session takes is unchanged
 *  B. per-call `target` — a Write lands on the named machine, no target lands on the root; the
 *     schema offers the names, the prompt lists both machines, events say where a call ran
 *  C. a misspelled target is an error result naming the available environments; nothing runs
 *  D. permission rules — an unscoped deny applies to the root only; a scoped one to its target
 *  E. session grants — approving a command for the session on one machine does not approve it
 *     on another
 *  F. the scheduler — the same path on two machines does not serialize
 *  G. a subagent sent to another machine (`Agent` + `target`) runs there: its home, its prompt
 *  H. user hooks — PreToolUse sees the call's environment; an `environments` filter is honoured
 *  I. Session.open — a bad or duplicate environment name fails the open
 *  J. the declaration is kept with the session: a reopen that leaves a machine out keeps the
 *     prompt and schemas byte-identical (cached prefix), refuses calls to it, and says so; an
 *     undeclared name fails the open; a moved working directory is a reminder, not a new prompt
 *  K. updateEnvironments — the one way the declaration changes; the root cannot be removed
 *  L. a `home-only` environment — a subagent sent there reaches nothing else
 *  M. auto mode — the judge is told which machine the action and each earlier call run on
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  defineAgent,
  EnvironmentTable,
  LocalEnvironment,
  ListenerSink,
  Runner,
  Session,
  LlmAutoApprover,
  MemoryStore,
  ToolAccesses,
  userHooksCapability,
  writeTool,
  type AgentEvent,
  type ApprovalRequest,
  type ChatModel,
  type LlmRequest,
  type Responder,
  type SessionOpenOptions,
} from "../index.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Context } from "./faux.ts";


const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const faux = registerFauxProvider();
// The faux step sees only the messages; the system prompt and tool schemas are read off the
// request the loop hands the model.
const requests: LlmRequest[] = [];
const base = faux.getChatModel()!;
const model = Object.create(base) as ChatModel;
const stream = base.stream.bind(base);
model.stream = (request, call) => {
  requests.push(request);
  return stream(request, call);
};
const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

interface Captured {
  readonly contexts: Context[];
  readonly events: AgentEvent[];
}

function capture(): Captured & { sink: ListenerSink } {
  const sink = new ListenerSink();
  const events: AgentEvent[] = [];
  sink.subscribe((event) => {
    events.push(event);
  });
  return { sink, events, contexts: [] };
}

function runnerFor(options: SessionOpenOptions): Runner {
  return new Runner({ session: () => options });
}

function schemaOf(request: LlmRequest | undefined, name: string): Record<string, unknown> | undefined {
  const tool = request?.tools?.find((t) => t.name === name);
  return tool?.parameters as Record<string, unknown> | undefined;
}

function toolResultTexts(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
}

function startedEvents(events: readonly AgentEvent[]): Array<Extract<AgentEvent, { type: "tool.call.started" }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: "tool.call.started" }> => e.type === "tool.call.started");
}

// ── A. single environment: nothing changes ─────────────────────────────────────────────
{
  const dir = tempDir("menv-a-");
  const cap = capture();
  const agent = defineAgent({ name: "solo", instructions: "base prompt", model, tools: [writeTool] });
  requests.length = 0;
  faux.setResponses([
    (context) => {
      cap.contexts.push(context);
      return fauxAssistantMessage(fauxToolCall("Write", { path: join(dir, "a.txt"), content: "A" }), { stopReason: "toolUse" });
    },
    (context) => {
      cap.contexts.push(context);
      return fauxAssistantMessage("done", { stopReason: "stop" });
    },
  ]);
  const result = await runnerFor({ environment: new LocalEnvironment(dir), events: cap.sink, permissionOptions: { mode: "yolo" } }).run(agent, "go");
  check("A: run completes", result.status === "completed");
  const props = schemaOf(requests[0], "Write")?.["properties"] as Record<string, unknown> | undefined;
  check("A: Write schema has no target", props !== undefined && !("target" in props));
  check("A: system prompt has no environment list", !(requests[0]?.systemPrompt ?? "").includes("# Environments"));
  check("A: system prompt is exactly the instructions", requests[0]?.systemPrompt === "base prompt");
  check("A: tool.call.started has no environment field", startedEvents(cap.events).every((e) => !("environment" in e)));
  check("A: the file was written", readFileSync(join(dir, "a.txt"), "utf8") === "A");
}

// ── B. per-call target ────────────────────────────────────────────────────────────────
{
  const local = tempDir("menv-b-local-");
  const build = tempDir("menv-b-build-");
  const cap = capture();
  const agent = defineAgent({ name: "multi", instructions: "base prompt", model, tools: [writeTool, bashTool] });
  requests.length = 0;
  faux.setResponses([
    (context) => {
      cap.contexts.push(context);
      return fauxAssistantMessage(
        [
          fauxToolCall("Write", { path: "out.txt", content: "on build", target: "build" }, { id: "w-build" }),
          fauxToolCall("Write", { path: "out.txt", content: "on local" }, { id: "w-local" }),
          fauxToolCall("Bash", { command: "pwd", target: "build" }, { id: "pwd-build" }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      cap.contexts.push(context);
      return fauxAssistantMessage("done", { stopReason: "stop" });
    },
  ]);
  const result = await runnerFor({
    environment: new LocalEnvironment(local),
    environmentName: "local",
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build), description: "the build machine" }],
    events: cap.sink,
    permissionOptions: { mode: "yolo" },
  }).run(agent, "go");
  check("B: run completes", result.status === "completed");
  const target = (schemaOf(requests[0], "Write")?.["properties"] as Record<string, { enum?: string[] }> | undefined)?.["target"];
  check("B: Write schema offers target with both names", JSON.stringify(target?.enum) === JSON.stringify(["local", "build"]));
  const required = schemaOf(requests[0], "Write")?.["required"] as string[] | undefined;
  check("B: target is optional", !(required ?? []).includes("target"));
  check("B: the schema is the same on the next step (cache-stable)", JSON.stringify(requests[0]?.tools) === JSON.stringify(requests[1]?.tools));
  const system = requests[0]?.systemPrompt ?? "";
  check("B: prompt keeps the instructions first", system.startsWith("base prompt\n\n# Environments"));
  check("B: prompt lists local as home", system.includes("- `local` (home)"));
  check("B: prompt lists build with its description and cwd", system.includes("- `build`: the build machine") && system.includes(`working directory: ${build}`));
  check("B: Write with target landed on build", readFileSync(join(build, "out.txt"), "utf8") === "on build");
  check("B: Write without target landed on local", readFileSync(join(local, "out.txt"), "utf8") === "on local");
  const outputs = toolResultTexts(cap.contexts[1]!);
  check("B: Bash pwd on build printed the build dir", outputs.some((text) => text.includes(build)));
  const started = startedEvents(cap.events);
  check("B: events name each call's environment", started.find((e) => e.toolCallId === "w-build")?.environment === "build" && started.find((e) => e.toolCallId === "w-local")?.environment === "local");
  check("B: the tool never saw target in its args", started.every((e) => !("target" in (e.args as Record<string, unknown>))));
  const results = cap.events.filter((e): e is Extract<AgentEvent, { type: "tool.result" }> => e.type === "tool.result");
  check("B: tool.result carries the environment", results.find((e) => e.toolCallId === "pwd-build")?.environment === "build");
}

// ── C. unknown target ─────────────────────────────────────────────────────────────────
{
  const local = tempDir("menv-c-local-");
  const build = tempDir("menv-c-build-");
  const cap = capture();
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [writeTool] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Write", { path: "x.txt", content: "x", target: "biuld" }), { stopReason: "toolUse" }),
    (context) => {
      cap.contexts.push(context);
      return fauxAssistantMessage("done", { stopReason: "stop" });
    },
  ]);
  await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build) }],
    events: cap.sink,
    permissionOptions: { mode: "yolo" },
  }).run(agent, "go");
  const text = toolResultTexts(cap.contexts[0]!).join("\n");
  check("C: error names the bad target and the available ones", text.includes(`Unknown environment "biuld"`) && text.includes("main, build"));
  check("C: nothing was written anywhere", !existsSync(join(local, "x.txt")) && !existsSync(join(build, "x.txt")));
}

// ── D. permission rules are scoped ────────────────────────────────────────────────────
{
  const local = tempDir("menv-d-local-");
  const build = tempDir("menv-d-build-");
  const test = tempDir("menv-d-test-");
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [writeTool] });
  faux.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("Write", { path: "d.txt", content: "root" }, { id: "d-root" }),
          fauxToolCall("Write", { path: "d.txt", content: "build", target: "build" }, { id: "d-build" }),
          fauxToolCall("Write", { path: "d.txt", content: "test", target: "test" }, { id: "d-test" }),
        ],
        { stopReason: "toolUse" },
      ),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [
      { name: "build", environment: new LocalEnvironment(build) },
      { name: "test", environment: new LocalEnvironment(test) },
    ],
    permissionOptions: {
      mode: "yolo",
      rules: [
        { decision: "deny", scope: "user", pattern: "Write" },
        { decision: "deny", scope: "user", pattern: "Write", environment: "test" },
      ],
    },
  }).run(agent, "go");
  check("D: unscoped deny blocked the root", !existsSync(join(local, "d.txt")));
  check("D: unscoped deny did not reach build", existsSync(join(build, "d.txt")));
  check("D: scoped deny blocked test", !existsSync(join(test, "d.txt")));
}

// ── E. session grants are scoped ──────────────────────────────────────────────────────
{
  const local = tempDir("menv-e-local-");
  const build = tempDir("menv-e-build-");
  const asked: ApprovalRequest[] = [];
  const responder: Responder = {
    requestApproval: async (request) => {
      asked.push(request);
      return { decision: "approved", scope: "session" };
    },
    isLiveApprover: () => true,
  };
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [bashTool] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Bash", { command: "touch made-e", target: "build" }, { id: "e1" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("Bash", { command: "touch made-e", target: "build" }, { id: "e2" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("Bash", { command: "touch made-e" }, { id: "e3" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build) }],
    responder,
    permissionOptions: { mode: "manual" },
  }).run(agent, "go");
  check("E: run completes", result.status === "completed");
  check("E: asked once on build, then again on main", asked.map((r) => r.toolCallId).join(",") === "e1,e3");
  check("E: the approval request names the environment", asked[0]?.environment === "build" && asked[1]?.environment === "main");
  check("E: both commands ran where they were sent", existsSync(join(build, "made-e")) && existsSync(join(local, "made-e")));
}

// ── F. scheduler: environments do not share resources ─────────────────────────────────
{
  const a = ToolAccesses.writeFile("/repo/out").map((x) => ({ ...x, environment: "sandbox-1:/repo" }));
  const b = ToolAccesses.writeFile("/repo/out").map((x) => ({ ...x, environment: "sandbox-2:/repo" }));
  const same = ToolAccesses.writeFile("/repo/out").map((x) => ({ ...x, environment: "sandbox-1:/repo" }));
  const unstamped = ToolAccesses.writeFile("/repo/out");
  const allOfOne = ToolAccesses.all().map((x) => ({ ...x, environment: "sandbox-2:/repo" }));
  check("F: same path on two environments does not conflict", !ToolAccesses.conflict(a, b));
  check("F: same path on one environment conflicts", ToolAccesses.conflict(a, same));
  check("F: an unstamped access still conflicts", ToolAccesses.conflict(a, unstamped));
  check("F: `all` of another environment does not conflict", !ToolAccesses.conflict(a, allOfOne));
  check("F: unstamped `all` conflicts with everything", ToolAccesses.conflict(a, ToolAccesses.all()));
}

// ── G. a subagent sent to another environment ─────────────────────────────────────────
{
  const local = tempDir("menv-g-local-");
  const build = tempDir("menv-g-build-");
  const childPrompts: string[] = [];
  let childOutput = "";
  const child = defineAgent({ name: "builder", instructions: "child prompt", model, tools: [bashTool], handoffDescription: "builds" });
  const parent = defineAgent({ name: "lead", instructions: "lead prompt", model, subagents: [child] });
  requests.length = 0;
  faux.setResponses([
    () => {
      return fauxAssistantMessage(
        fauxToolCall("Agent", { subagent_type: "builder", description: "build it", prompt: "print where you are", target: "build" }),
        { stopReason: "toolUse" },
      );
    },
    () => {
      childPrompts.push(requests.at(-1)?.systemPrompt ?? "");
      return fauxAssistantMessage(fauxToolCall("Bash", { command: "pwd" }), { stopReason: "toolUse" });
    },
    (context) => {
      childOutput = toolResultTexts(context).join("\n");
      return fauxAssistantMessage("built", { stopReason: "stop" });
    },
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build) }],
    permissionOptions: { mode: "yolo" },
  }).run(parent, "go");
  check("G: run completes", result.status === "completed");
  const agentProps = schemaOf(requests[0], "Agent")?.["properties"] as Record<string, unknown> | undefined;
  check("G: the Agent tool offers target", agentProps !== undefined && "target" in agentProps);
  check("G: the child's prompt marks build as its home", childPrompts[0]?.includes("- `build` (home)") === true);
  check("G: the child's Bash without target ran on build", childOutput.includes(build) && !childOutput.includes(local));
}

// ── H. user hooks see the environment ─────────────────────────────────────────────────
{
  const local = tempDir("menv-h-local-");
  const build = tempDir("menv-h-build-");
  const log = join(local, "hook.log");
  const buildOnly = join(local, "hook-build-only.log");
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [writeTool] });
  faux.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("Write", { path: "h.txt", content: "b", target: "build" }, { id: "h-build" }),
          fauxToolCall("Write", { path: "h.txt", content: "m" }, { id: "h-main" }),
        ],
        { stopReason: "toolUse" },
      ),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build) }],
    permissionOptions: { mode: "yolo" },
    capabilities: [
      userHooksCapability([
        { event: "PreToolUse", command: `cat >> '${log}'; echo >> '${log}'` },
        { event: "PreToolUse", command: `cat >> '${buildOnly}'; echo >> '${buildOnly}'`, environments: ["build"] },
      ]),
    ],
  }).run(agent, "go");
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  check("H: PreToolUse saw build with its cwd", lines.some((l) => l["environment"] === "build" && l["environment_cwd"] === build));
  check("H: PreToolUse saw main", lines.some((l) => l["environment"] === "main"));
  check("H: tool_input has no target", lines.every((l) => !("target" in (l["tool_input"] as Record<string, unknown>))));
  const filtered = readFileSync(buildOnly, "utf8").trim().split("\n");
  check("H: an environments filter fires only for its environment", filtered.length === 1 && filtered[0]!.includes('"environment":"build"'));
}

// ── I. Session.open validates the table ───────────────────────────────────────────────
{
  const dir = tempDir("menv-i-");
  const env = new LocalEnvironment(dir);
  const fails = async (options: SessionOpenOptions): Promise<boolean> => {
    try {
      const session = await Session.open(options);
      await session.close();
      return false;
    } catch {
      return true;
    }
  };
  check("I: a bad name fails the open", await fails({ environment: env, additionalEnvironments: [{ name: "Build Box", environment: env }] }));
  check("I: a duplicate of the root's name fails the open", await fails({ environment: env, additionalEnvironments: [{ name: "main", environment: env }] }));
  check("I: a failing factory fails the open", await fails({ environment: env, additionalEnvironments: [{ name: "build", environment: () => { throw new Error("unreachable"); } }] }));
  const session = await Session.open({ environment: env });
  check("I: a plain session has a table of one named main", session.environments.size === 1 && session.environments.rootName === "main");
  await session.close();
  const table = new EnvironmentTable({ name: "a", environment: env }, [{ name: "b", environment: env, identity: "shared" }, { name: "c", environment: env, identity: "shared" }]);
  check("I: explicit identities are kept", table.get("b")?.identity === "shared" && table.get("c")?.identity === "shared");
}

function messageText(request: LlmRequest | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}

// ── J. the declaration persists; a reopen only supplies instances ─────────────────────
{
  const local = tempDir("menv-j-local-");
  const build = tempDir("menv-j-build-");
  const moved = tempDir("menv-j-moved-");
  const store = new MemoryStore();
  const agent = defineAgent({ name: "multi", instructions: "base prompt", model, tools: [writeTool] });

  const first = await Session.open({
    store,
    sessionId: "menv-j",
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build), description: "the build machine" }],
    permissionOptions: { mode: "yolo" },
  });
  requests.length = 0;
  faux.setResponses([() => fauxAssistantMessage("hello", { stopReason: "stop" })]);
  await new Runner().run(agent, "hi", { session: first });
  const firstRequest = requests[0];
  await first.close();

  const second = await Session.open({ store, sessionId: "menv-j", environment: new LocalEnvironment(local), permissionOptions: { mode: "yolo" } });
  check("J: the reopened session still declares build", second.environments.names.join(",") === "main,build" && second.environments.get("build")?.available === false);
  requests.length = 0;
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Write", { path: "j.txt", content: "x", target: "build" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  await new Runner().run(agent, "write on build", { session: second });
  check("J: the system prompt is byte-identical without build connected", requests[0]?.systemPrompt === firstRequest?.systemPrompt);
  check("J: the tool schemas are byte-identical without build connected", JSON.stringify(requests[0]?.tools) === JSON.stringify(firstRequest?.tools));
  check("J: the model is told build is not connected", messageText(requests[0]).includes("Not connected right now: `build`"));
  check("J: a call to build is refused, nothing written", messageText(requests[1]).includes(String.raw`Environment \"build\" is not connected right now`) && !existsSync(join(build, "j.txt")) && !existsSync(join(local, "j.txt")));
  await second.close();

  let undeclared = false;
  try {
    const s = await Session.open({ store, sessionId: "menv-j", environment: new LocalEnvironment(local), additionalEnvironments: [{ name: "test", environment: new LocalEnvironment(build) }] });
    await s.close();
  } catch (error) {
    undeclared = error instanceof Error && error.message.includes(`"test" is not declared`);
  }
  check("J: an undeclared name fails the reopen", undeclared);

  let failing = false;
  const third = await Session.open({
    store,
    sessionId: "menv-j",
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: () => { failing = true; throw new Error("ssh refused"); } }],
  });
  check("J: a failing factory on reopen leaves the environment unavailable instead of failing", failing && third.environments.get("build")?.available === false);
  check("J: and says why", third.drainDiagnostics().some((d) => d.message.includes("ssh refused")));
  await third.close();

  const fourth = await Session.open({
    store,
    sessionId: "menv-j",
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(moved) }],
    permissionOptions: { mode: "yolo" },
  });
  requests.length = 0;
  faux.setResponses([() => fauxAssistantMessage("ok", { stopReason: "stop" })]);
  await new Runner().run(agent, "hi again", { session: fourth });
  check("J: a moved cwd keeps the prompt as declared", requests[0]?.systemPrompt === firstRequest?.systemPrompt);
  check("J: and reminds the model where it is now", messageText(requests[0]).includes(`working directory is now ${moved}`));
  await fourth.close();
}

// ── K. updateEnvironments ─────────────────────────────────────────────────────────────
{
  const local = tempDir("menv-k-local-");
  const build = tempDir("menv-k-build-");
  const test = tempDir("menv-k-test-");
  const store = new MemoryStore();
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [writeTool] });
  const session = await Session.open({
    store,
    sessionId: "menv-k",
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "build", environment: new LocalEnvironment(build) }],
    permissionOptions: { mode: "yolo" },
  });
  await session.updateEnvironments({ add: [{ name: "test", environment: new LocalEnvironment(test), description: "test sandbox" }], remove: ["build"] });
  requests.length = 0;
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Write", { path: "k.txt", content: "k", target: "test" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  await new Runner().run(agent, "go", { session });
  const target = (schemaOf(requests[0], "Write")?.["properties"] as Record<string, { enum?: string[] }> | undefined)?.["target"];
  check("K: the schema follows the update", JSON.stringify(target?.enum) === JSON.stringify(["main", "test"]));
  check("K: the model is told what changed", messageText(requests[0]).includes("added `test`: test sandbox") && messageText(requests[0]).includes("removed `build`"));
  check("K: the new environment works", readFileSync(join(test, "k.txt"), "utf8") === "k");
  let rootRefused = false;
  try {
    await session.updateEnvironments({ remove: ["main"] });
  } catch {
    rootRefused = true;
  }
  check("K: the root cannot be removed", rootRefused);
  await session.close();
  const reopened = await Session.open({ store, sessionId: "menv-k", environment: new LocalEnvironment(local) });
  check("K: the update is what a reopen declares", reopened.environments.names.join(",") === "main,test");
  await reopened.close();
}

// ── L. home-only: a subagent sent there reaches nothing else ──────────────────────────
{
  const local = tempDir("menv-l-local-");
  const sandbox = tempDir("menv-l-sandbox-");
  let childOutput = "";
  const child = defineAgent({ name: "runner", instructions: "child prompt", model, tools: [writeTool, bashTool], handoffDescription: "runs" });
  const parent = defineAgent({ name: "lead", instructions: "lead prompt", model, subagents: [child] });
  requests.length = 0;
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "runner", description: "run it", prompt: "go", target: "sandbox" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("Write", { path: "escape.txt", content: "x", target: "main" }), { stopReason: "toolUse" }),
    (context) => {
      childOutput = toolResultTexts(context).join("\n");
      return fauxAssistantMessage("done", { stopReason: "stop" });
    },
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const result = await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "sandbox", environment: new LocalEnvironment(sandbox), subagentAccess: "home-only" }],
    permissionOptions: { mode: "yolo" },
  }).run(parent, "go");
  check("L: run completes", result.status === "completed");
  const childProps = schemaOf(requests[1], "Write")?.["properties"] as Record<string, unknown> | undefined;
  check("L: the child's tools offer no target (it reaches one environment)", childProps !== undefined && !("target" in childProps));
  check("L: the child's prompt has no environment list", !(requests[1]?.systemPrompt ?? "").includes("# Environments"));
  check("L: the child could not write to main", !existsSync(join(local, "escape.txt")));
  check("L: nor was the target silently dropped (nothing written at home)", !existsSync(join(sandbox, "escape.txt")));
  check("L: the child is told main is not reachable", childOutput.includes(`Environment "main" is not reachable from this agent`) && childOutput.includes("can run on: sandbox"));
}

// ── M. auto mode sees the environment ─────────────────────────────────────────────────
{
  const local = tempDir("menv-m-local-");
  const scratch = tempDir("menv-m-scratch-");
  const judgeFaux = registerFauxProvider();
  const judgeBase = judgeFaux.getChatModel()!;
  const judgeModel = Object.create(judgeBase) as ChatModel;
  const judgeComplete = judgeBase.complete.bind(judgeBase);
  const judged: string[] = [];
  judgeModel.complete = (request, call) => {
    judged.push(JSON.stringify(request.messages));
    return judgeComplete(request, call);
  };
  judgeFaux.setResponses([
    () => fauxAssistantMessage("<block>no</block>", { stopReason: "stop" }),
    () => fauxAssistantMessage("<block>no</block>", { stopReason: "stop" }),
  ]);
  const agent = defineAgent({ name: "multi", instructions: "x", model, tools: [bashTool] });
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Bash", { command: "touch one", target: "scratch" }, { id: "m1" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("Bash", { command: "touch two" }, { id: "m2" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  await runnerFor({
    environment: new LocalEnvironment(local),
    additionalEnvironments: [{ name: "scratch", environment: new LocalEnvironment(scratch), description: "throwaway sandbox" }],
    permissionOptions: { mode: "auto", autoApprover: new LlmAutoApprover({ model: judgeModel, twoStageMode: "fast" }) },
  }).run(agent, "go");
  judgeFaux.unregister();
  check("M: the judge was consulted twice", judged.length === 2);
  check("M: the action's environment is a meta line with its description", (judged[0] ?? "").includes(String.raw`{\"meta\":{\"environment\":{\"name\":\"scratch\",\"description\":\"throwaway sandbox\"}}}`));
  check("M: an untargeted action is marked as the home environment", (judged[1] ?? "").includes(String.raw`{\"meta\":{\"environment\":{\"name\":\"main\",\"home\":true}}}`));
  check("M: earlier calls in the transcript keep their environment", (judged[1] ?? "").includes(String.raw`\"name\":\"scratch\"`));
  check("M: both commands ran where they were sent", existsSync(join(scratch, "one")) && existsSync(join(local, "two")));
}

for (const dir of roots) rmSync(dir, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("❌ MULTI-ENVIRONMENT E2E FAIL");
  process.exit(1);
}
console.log("✅ MULTI-ENVIRONMENT E2E PASS");
