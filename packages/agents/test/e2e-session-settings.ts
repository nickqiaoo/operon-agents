/**
 * A session replaces what the harness set, whole, and which model each frame runs on follows one
 * order: `agent(prompt, { model })`, the subagent's own model, the session's, the harness's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, defineAgent, type HarnessOptions } from "../src/index.ts";
import { defineTool, filesystemTools } from "../src/tools.ts";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, offeredToolNames, registerFauxProvider, type Context } from "./faux.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok" : "  FAIL"} ${name}${ok || detail === "" ? "" : ` (${detail})`}`);
  if (!ok) failed += 1;
}

interface Seen {
  readonly model: string;
  readonly temperature: unknown;
  readonly maxTokens: unknown;
  readonly tools: readonly string[];
  readonly lastMessage: string;
}

type Message = ReturnType<typeof fauxAssistantMessage>;

const workDir = mkdtempSync(join(tmpdir(), "session-settings-"));
const stop = (text: string): Message => fauxAssistantMessage(text, { stopReason: "stop" });

function provider() {
  return registerFauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "other" }] });
}

type Faux = ReturnType<typeof provider>;

/** Script the provider's answers and record what each request looked like. */
function script(faux: Faux, messages: readonly Message[]): Seen[] {
  const seen: Seen[] = [];
  faux.setResponses(messages.map((message) => (context: Context, options: { temperature?: unknown; maxTokens?: unknown } | undefined, _state: unknown, model: { id: string }) => {
    seen.push({
      model: model.id,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      tools: offeredToolNames(context),
      lastMessage: JSON.stringify(context.messages.at(-1)),
    });
    return message;
  }) as never);
  return seen;
}

function harnessOn(faux: Faux, options: Partial<HarnessOptions> = {}) {
  return createHarness({
    ...faux.harnessModel(), ...options,
    config: { workDir, ...options.config, defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" }, ...options.config?.defaults } },
  });
}

async function modelReplacesTheHarnessDefault(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [stop("a"), stop("b"), stop("c"), stop("d")]);
  const harness = harnessOn(faux);

  await (await harness.createSession()).prompt("hi");
  check("model: a session that names none runs on the harness default", seen[0]?.model === "main", seen[0]?.model);

  const named = await harness.createSession({
    config: { model: "faux/other" }
  });
  await named.prompt("hi");
  check("model: a session's id replaces the default", seen[1]?.model === "other", seen[1]?.model);

  await (await harness.createSession({
    bindings: { model: faux.getChatModel("other")! }
  })).prompt("hi");
  check("model: a session may bring a built ChatModel", seen[2]?.model === "other", seen[2]?.model);

  await named.close();
  await (await harness.resumeSession(named.id)).prompt("hi");
  check("model: a resume that names none keeps the session's model", seen[3]?.model === "other", seen[3]?.model);
  await harness.close();
}

async function settingsReplaceWholeNotMerge(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [stop("a"), stop("b"), stop("c"), stop("d")]);
  const tools = filesystemTools({ mode: "readonly" });
  const harness = harnessOn(faux, {
    config: { defaults: { modelSettings: { temperature: 0.1, maxTokens: 111 } } }
  });

  await (await harness.createSession()).prompt("hi");
  check("modelSettings: the harness's apply by default", seen[0]?.temperature === 0.1 && seen[0]?.maxTokens === 111);
  check("tools: the default palette includes Write", seen[0]?.tools.includes("Write") === true);

  await (await harness.createSession({
    config: { modelSettings: { temperature: 0.9 } }
  })).prompt("hi");
  check("modelSettings: a session's replace them whole", seen[1]?.temperature === 0.9 && seen[1]?.maxTokens === undefined);

  await (await harness.createSession({
    bindings: { tools: tools }
  })).prompt("hi");
  check("tools: a session's palette replaces the default", seen[2]?.tools.includes("Read") === true && seen[2]?.tools.includes("Write") === false);

  await (await harness.createSession()).prompt("hi");
  check("tools: other sessions keep the harness's", seen[3]?.tools.includes("Write") === true);
  await harness.close();
}

async function subagentSettingsAreOneSessionEach(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [stop("a"), stop("b"), stop("c")]);
  const harness = harnessOn(faux);

  await (await harness.createSession()).prompt("hi");
  check("workflow: offered by default", seen[0]?.tools.includes("Workflow") === true);

  await (await harness.createSession({
    config: { subagents: { workflowTool: false } }
  })).prompt("hi");
  check("workflowTool: false withholds it from this session and keeps Agent", seen[1]?.tools.includes("Workflow") === false && seen[1]?.tools.includes("Agent") === true);

  await (await harness.createSession({
    config: { subagents: false }
  })).prompt("hi");
  check("subagentProvider: null hides Agent for this session", seen[2]?.tools.includes("Agent") === false && seen[2]?.tools.includes("Workflow") === false);
  await harness.close();

  const off = provider();
  const offSeen = script(off, [stop("a"), stop("b")]);
  const closed = harnessOn(off, {
    config: { defaults: { subagents: false } }
  });
  await (await closed.createSession()).prompt("hi");
  check("subagentProvider: null on the harness hides Agent", offSeen[0]?.tools.includes("Agent") === false);
  await closed.close();
}

async function disabledToolsAreGone(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [
    stop("a"),
    fauxAssistantMessage(fauxToolCall("Bash", { command: "echo ran", description: "Echo" }), { stopReason: "toolUse" }),
    stop("b"),
    stop("c"),
    stop("d"),
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "coder", prompt: "look", description: "look" }), { stopReason: "toolUse" }),
    stop("child"),
    stop("e"),
  ]);
  const harness = harnessOn(faux, {
    config: { defaults: { disabledTools: ["Monitor"] } }
  });

  await (await harness.createSession()).prompt("hi");
  check("disabledTools: the harness's apply by default", seen[0]?.tools.includes("Monitor") === false && seen[0]?.tools.includes("Bash") === true);

  const narrowed = await harness.createSession({
    config: { disabledTools: ["Bash", "Workflow"] }
  });
  await narrowed.prompt("go");
  const offered = seen[1]?.tools ?? [];
  check("disabledTools: a session's leave its tools out of the request", !offered.includes("Bash") && !offered.includes("Workflow") && offered.includes("Read") && offered.includes("Agent"), offered.join(","));
  check("disabledTools: a session's replace the harness's whole", offered.includes("Monitor"));
  check("disabledTools: a call to one fails as unknown, even in yolo mode", seen[2]?.lastMessage.includes("unknown tool: Bash") === true, seen[2]?.lastMessage);

  await narrowed.close();
  await (await harness.resumeSession(narrowed.id)).prompt("hi");
  check("disabledTools: a resumed session keeps them", seen[3]?.tools.includes("Bash") === false);

  await (await harness.createSession({
    config: { disabledTools: [] }
  })).prompt("hi");
  check("disabledTools: an empty list brings everything back", seen[4]?.tools.includes("Monitor") === true);

  await (await harness.createSession({
    config: { disabledTools: ["Bash"] }
  })).prompt("go");
  check("disabledTools: a subagent inherits them", seen[6] !== undefined && !seen[6].tools.includes("Bash") && seen[6].tools.includes("Read"), seen[6]?.tools.join(","));
  await harness.close();
}

async function extraToolsAreTheRootAgents(): Promise<void> {
  const faux = provider();
  const calls: string[] = [];
  const ping = defineTool({
    name: "ping_host",
    description: "Tell the host something.",
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      calls.push(text);
      return `pong ${text}`;
    },
  });
  const seen = script(faux, [
    fauxAssistantMessage(fauxToolCall("ping_host", { text: "one" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "coder", prompt: "look", description: "look" }), { stopReason: "toolUse" }),
    stop("child"),
    stop("a"),
    stop("b"),
    fauxAssistantMessage(fauxToolCall("ping_host", { text: "two" }), { stopReason: "toolUse" }),
    stop("c"),
  ]);
  const harness = harnessOn(faux);
  const session = await harness.createSession({ bindings: { extraTools: [ping] } });
  await session.prompt("go");
  check("extraTools: offered to the root agent beside its profile's", seen[0]?.tools.includes("ping_host") === true && seen[0]?.tools.includes("Read") === true);
  check("extraTools: run in process", calls[0] === "one" && seen[1]?.lastMessage.includes("pong one") === true, seen[1]?.lastMessage);
  check("extraTools: not handed to its subagents", seen[2] !== undefined && !seen[2].tools.includes("ping_host"), seen[2]?.tools.join(","));

  await (await harness.createSession({ config: { disabledTools: ["ping_host"] }, bindings: { extraTools: [ping] } })).prompt("hi");
  check("extraTools: disabledTools still applies", seen[4]?.tools.includes("ping_host") === false);

  await session.close();
  let missing = "";
  try {
    await harness.resumeSession(session.id);
  } catch (error) {
    missing = error instanceof Error ? error.name : String(error);
  }
  check("extraTools: a restore must hand them in again", missing === "SessionDependencyMissingError", missing);
  await (await harness.resumeSession(session.id, { bindings: { extraTools: [ping] } })).prompt("again");
  check("extraTools: handed in again, they work after a restore", calls[1] === "two");

  let clash = "";
  try {
    await harness.createSession({ bindings: { extraTools: [defineTool({ name: "Read", description: "", parameters: z.object({}), execute: async () => "" })] } });
  } catch (error) {
    clash = error instanceof Error ? error.message : String(error);
  }
  check("extraTools: a name the profile already uses is an error", clash.includes('extra tool "Read"'), clash);
  await harness.close();
}

/** How many child requests overlapped when a parent spawned two at once. */
async function peakConcurrency(session: { prompt(input: string): Promise<unknown> }, faux: Faux): Promise<number> {
  let active = 0;
  let peak = 0;
  const child = async (): Promise<Message> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return stop("child");
  };
  const spawn = (i: number) => fauxToolCall("Agent", { subagent_type: "coder", prompt: `task ${i}`, description: `t${i}` });
  faux.setResponses([fauxAssistantMessage([spawn(1), spawn(2)], { stopReason: "toolUse" }), child, child, stop("done")] as never);
  await session.prompt("go");
  return peak;
}

async function concurrencyCapIsPerSession(): Promise<void> {
  const faux = provider();
  const harness = harnessOn(faux, {
    config: { defaults: { subagents: { maxConcurrent: 4 } } }
  });
  const open = await peakConcurrency(await harness.createSession(), faux);
  check("maxConcurrentSubagents: the harness's cap lets two overlap", open === 2, String(open));
  const capped = await peakConcurrency(await harness.createSession({
    config: { subagents: { maxConcurrent: 1 } }
  }), faux);
  check("maxConcurrentSubagents: a session's cap replaces it", capped === 1, String(capped));
  await harness.close();
}

const workflow = (call: string): string => `export const meta = { name: 'demo', description: 'demo' }\nreturn await ${call};`;

async function childModel(
  call: string,
  options: { helper?: boolean; sessionModel?: string; agentModel?: string } = {},
): Promise<{ readonly models: readonly string[]; readonly result: string }> {
  const faux = provider();
  const seen = script(faux, [fauxAssistantMessage(fauxToolCall("Workflow", { script: workflow(call) }), { stopReason: "toolUse" }), stop("child"), stop("done")]);
  const helper = defineAgent({ name: "helper", model: "faux/other", instructions: "Help." });
  const harness = harnessOn(faux, options.helper
    ? { config: { defaults: { agent: "lead" } }, registry: { agents: { lead: defineAgent({ name: "lead", model: "faux/main", instructions: "Lead.", subagents: [helper] }) } } }
    : {});
  const session = await harness.createSession(options.sessionModel !== undefined ? { config: { model: options.sessionModel } } : {});
  await session.prompt("go");
  await harness.close();
  return { models: seen.map((entry) => entry.model), result: seen.at(-1)?.lastMessage ?? "" };
}

async function subagentModelOrder(): Promise<void> {
  const explicit = await childModel(`agent("x", { model: "faux/other" })`);
  check("order: agent(prompt, { model }) picks the child's model", explicit.models.join() === "main,other,main", explicit.models.join());

  const beatsSession = await childModel(`agent("x", { model: "faux/other" })`, { sessionModel: "faux/main" });
  check("order: agent(prompt, { model }) beats the session's", beatsSession.models.join() === "main,other,main", beatsSession.models.join());

  const declared = await childModel(`agent("x", { agentType: "helper" })`, { helper: true, sessionModel: "faux/main" });
  check("order: a subagent's declared model beats the session's", declared.models.join() === "main,other,main", declared.models.join());

  const inheritsSession = await childModel(`agent("x")`, { sessionModel: "faux/other" });
  check("order: an undeclared child runs on the session's model", inheritsSession.models.join() === "other,other,other", inheritsSession.models.join());

  const inheritsDefault = await childModel(`agent("x")`);
  check("order: an undeclared child falls back to the harness default", inheritsDefault.models.join() === "main,main,main", inheritsDefault.models.join());

  const faux = provider();
  const seen = script(faux, [fauxAssistantMessage(fauxToolCall("Workflow", { script: workflow(`agent("x", { model: "faux/nope" })`) }), { stopReason: "toolUse" }), stop("done")]);
  const harness = harnessOn(faux);
  await (await harness.createSession()).prompt("go");
  await harness.close();
  check("order: a model id that names nothing fails that agent clearly", seen.at(-1)?.lastMessage.includes("unknown model") === true, seen.at(-1)?.lastMessage);

  const root = provider();
  const rootSeen = script(root, [stop("a")]);
  const rootHarness = harnessOn(root, {
    config: { defaults: { agent: "default" } },
    registry: { agents: { default: defineAgent({ name: "lead", model: "faux/main", instructions: "Lead." }) } }
  });
  await (await rootHarness.createSession({
    config: { model: "faux/other" }
  })).prompt("hi");
  await rootHarness.close();
  check("order: a session's model still beats its root agent's", rootSeen[0]?.model === "other", rootSeen[0]?.model);
}

try {
  await modelReplacesTheHarnessDefault();
  await settingsReplaceWholeNotMerge();
  await subagentSettingsAreOneSessionEach();
  await disabledToolsAreGone();
  await extraToolsAreTheRootAgents();
  await concurrencyCapIsPerSession();
  await subagentModelOrder();
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
if (failed > 0) process.exit(1);
console.log("all passed");
