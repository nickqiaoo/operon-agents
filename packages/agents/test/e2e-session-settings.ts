/**
 * A session replaces what the harness set, whole, and which model each frame runs on follows one
 * order: `agent(prompt, { model })`, the subagent's own model, the session's, the harness's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, defineAgent, filesystemTools, type HarnessOptions } from "../src/index.ts";
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
  return createHarness({ ...faux.harnessModel(), permission: { mode: "yolo" }, workDir, ...options });
}

async function modelReplacesTheHarnessDefault(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [stop("a"), stop("b"), stop("c"), stop("d")]);
  const harness = harnessOn(faux);

  await (await harness.createSession()).prompt("hi");
  check("model: a session that names none runs on the harness default", seen[0]?.model === "main", seen[0]?.model);

  const named = await harness.createSession({ model: "faux/other" });
  await named.prompt("hi");
  check("model: a session's id replaces the default", seen[1]?.model === "other", seen[1]?.model);

  await (await harness.createSession({ model: faux.getChatModel("other")! })).prompt("hi");
  check("model: a session may bring a built ChatModel", seen[2]?.model === "other", seen[2]?.model);

  await named.close();
  await (await harness.resumeSession(named.id)).prompt("hi");
  check("model: a resume that names none is back on the default", seen[3]?.model === "main", seen[3]?.model);
  await harness.close();
}

async function settingsReplaceWholeNotMerge(): Promise<void> {
  const faux = provider();
  const seen = script(faux, [stop("a"), stop("b"), stop("c"), stop("d")]);
  const tools = filesystemTools({ mode: "readonly" });
  const harness = harnessOn(faux, { modelSettings: { temperature: 0.1, maxTokens: 111 } });

  await (await harness.createSession()).prompt("hi");
  check("modelSettings: the harness's apply by default", seen[0]?.temperature === 0.1 && seen[0]?.maxTokens === 111);
  check("tools: the default palette includes Write", seen[0]?.tools.includes("Write") === true);

  await (await harness.createSession({ modelSettings: { temperature: 0.9 } })).prompt("hi");
  check("modelSettings: a session's replace them whole", seen[1]?.temperature === 0.9 && seen[1]?.maxTokens === undefined);

  await (await harness.createSession({ tools })).prompt("hi");
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

  await (await harness.createSession({ workflowTool: false })).prompt("hi");
  check("workflowTool: false withholds it from this session and keeps Agent", seen[1]?.tools.includes("Workflow") === false && seen[1]?.tools.includes("Agent") === true);

  await (await harness.createSession({ subagentProvider: null })).prompt("hi");
  check("subagentProvider: null hides Agent for this session", seen[2]?.tools.includes("Agent") === false && seen[2]?.tools.includes("Workflow") === false);
  await harness.close();

  const off = provider();
  const offSeen = script(off, [stop("a"), stop("b")]);
  const closed = harnessOn(off, { subagentProvider: null });
  await (await closed.createSession()).prompt("hi");
  check("subagentProvider: null on the harness hides Agent", offSeen[0]?.tools.includes("Agent") === false);
  await closed.close();
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
  const harness = harnessOn(faux, { maxConcurrentSubagents: 4 });
  const open = await peakConcurrency(await harness.createSession(), faux);
  check("maxConcurrentSubagents: the harness's cap lets two overlap", open === 2, String(open));
  const capped = await peakConcurrency(await harness.createSession({ maxConcurrentSubagents: 1 }), faux);
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
    ? { agent: defineAgent({ name: "lead", model: "faux/main", instructions: "Lead.", subagents: [helper] }) }
    : {});
  const session = await harness.createSession(options.sessionModel !== undefined ? { model: options.sessionModel } : {});
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
  const rootHarness = harnessOn(root, { agent: defineAgent({ name: "lead", model: "faux/main", instructions: "Lead." }) });
  await (await rootHarness.createSession({ model: "faux/other" })).prompt("hi");
  await rootHarness.close();
  check("order: a session's model still beats its root agent's", rootSeen[0]?.model === "other", rootSeen[0]?.model);
}

try {
  await modelReplacesTheHarnessDefault();
  await settingsReplaceWholeNotMerge();
  await subagentSettingsAreOneSessionEach();
  await concurrencyCapIsPerSession();
  await subagentModelOrder();
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
if (failed > 0) process.exit(1);
console.log("all passed");
