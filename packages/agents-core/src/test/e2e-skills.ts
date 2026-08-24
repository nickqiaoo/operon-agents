import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  Runner,
  Session,
  LocalMachine,
  SkillRegistry,
  SteerBus,
  ListenerSink,
  skillsCapability,
  resolveSkillRoots,
  type AgentEvent,
  type FlowSkillRequest,
  type Message,
  type SkillRoot,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function reminderText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter((t) => t.includes("<system-reminder>"))
    .join("\n");
}

function toolResultText(messages: readonly Message[], name: string): { text: string; isError: boolean } {
  const m = [...messages].reverse().find((x) => x.role === "toolResult" && x.toolName === name);
  if (!m || m.role !== "toolResult") return { text: "", isError: false };
  return { text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError ?? false };
}

function writeSkill(dir: string, name: string, frontmatter: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
}

function buildSkillTree(root: string): { roots: readonly SkillRoot[] } {
  const projectSkills = join(root, "project", ".agents", "skills");
  const userSkills = join(root, "user", ".agents", "skills");

  // inline bundle with a declared argument
  writeSkill(join(projectSkills, "greeter"), "SKILL.md", "name: greeter\ndescription: Greets a person by name.\narguments: name", "Greeting for $name.");
  // same name in project + user → project wins
  writeSkill(join(projectSkills, "dup"), "SKILL.md", "name: dup\ndescription: Project version of dup.", "project dup body");
  writeSkill(join(userSkills, "dup"), "SKILL.md", "name: dup\ndescription: User version of dup.", "user dup body");
  // flat single-file skill at a root top level (folded `>` whenToUse exercises the block-scalar reader)
  writeSkill(userSkills, "flat.md", "name: flatskill\ndescription: A flat single-file skill.\nwhenToUse: >\n  When you need\n  the flat skill.", "flat body");
  // flow skill → becomes a skill_<name> tool
  writeSkill(join(userSkills, "summarizer"), "SKILL.md", "name: summarizer\ndescription: Summarizes input text.\ntype: flow\nwhenToUse: When the user asks for a summary.", "You are a summarizer. Reply with a one-line summary.");
  // unsupported type → skipped
  writeSkill(join(userSkills, "broken"), "SKILL.md", "name: broken\ndescription: Unsupported.\ntype: python", "nope");
  // user-only → not model-invocable
  writeSkill(join(userSkills, "useronly"), "SKILL.md", "name: user-only\ndescription: Only the user can trigger this.\ndisable-model-invocation: true", "secret body");

  return { roots: [{ path: projectSkills, source: "project" }, { path: userSkills, source: "user" }] };
}

async function testScanAndPrecedence(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const registry = new SkillRegistry();
  await registry.loadRoots(machine, roots);

  check("scan: greeter bundle discovered", registry.getSkill("greeter")?.description === "Greets a person by name.");
  check("scan: flat .md skill discovered", registry.getSkill("flatskill") !== undefined);
  check("scan: precedence — project shadows user (dup)", registry.getSkill("dup")?.source === "project");
  check("scan: unsupported type skipped", registry.getSkill("broken") === undefined && registry.getSkippedByPolicy().some((s) => s.type === "python"));
  check("scan: flow skill classified", registry.listFlowSkills().some((s) => s.name === "summarizer"));
  check("scan: folded block scalar parsed (flatskill whenToUse)", registry.getSkill("flatskill")?.metadata.whenToUse === "When you need the flat skill.");

  const invocable = registry.listInvocableSkills().map((s) => s.name).toSorted();
  check("scan: listInvocableSkills excludes flow + user-only + skipped", JSON.stringify(invocable) === JSON.stringify(["dup", "flatskill", "greeter"]));

  const rendered = registry.renderSkillPrompt(registry.getSkill("greeter")!, "World");
  check("scan: renderSkillPrompt expands declared arg", rendered === "Greeting for World.");
}

async function testCatalogInjection(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hi", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const runner = new Runner({ machine, capabilities: [skillsCapability({ roots })], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "hello");
  faux.unregister();

  const reminder = reminderText(result.messages);
  check("injector: available-skills listing injected", reminder.includes("Available skills") && reminder.includes("greeter"));
  check("injector: flow skill listed as (flow)", reminder.includes("summarizer (flow)"));
  check("injector: user-only skill NOT listed", !reminder.includes("user-only"));
}

async function testSkillToolInline(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Skill", { skill: "greeter", args: "World" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("followed it", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const runner = new Runner({ machine, capabilities: [skillsCapability({ roots })], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "use the greeter");
  faux.unregister();

  const r = toolResultText(result.messages, "Skill");
  check("skill-tool: inline body returned into transcript", !r.isError && r.text.includes("Greeting for World."));
  check("skill-tool: wrapped as <skill-loaded>", r.text.includes('<skill-loaded name="greeter" args="World">'));
}

async function testUserOnlyRefused(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Skill", { skill: "user-only" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ok", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const runner = new Runner({ machine, capabilities: [skillsCapability({ roots })], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "try the user-only skill");
  faux.unregister();

  const r = toolResultText(result.messages, "Skill");
  check("skill-tool: refuses disableModelInvocation skill", r.isError && r.text.includes("can only be triggered by the user"));
}

async function testFlowSkillSubRunner(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("skill_summarizer", { input: "a very long passage to compress" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("SUMMARY: compressed.", { stopReason: "stop" }), // flow sub-agent
    fauxAssistantMessage("relayed the summary", { stopReason: "stop" }), // main, after flow result
  ]);
  const model = faux.getChatModel()!;

  let seenInstructions = "";
  // The runtime handle the host wires: run the flow skill as a sub-agent (agent-as-tool / sub-Runner).
  const flowExecutor = async (req: FlowSkillRequest): Promise<string> => {
    seenInstructions = req.instructions;
    const sub = defineAgent({ name: "summarizer", model, instructions: req.instructions });
    const subRunner = new Runner({ machine, permission: { mode: "yolo" } });
    const res = await subRunner.run(sub, req.input, { signal: req.signal });
    return res.output;
  };

  const agent = defineAgent({ name: "a", model, instructions: "x" });
  const runner = new Runner({ machine, capabilities: [skillsCapability({ roots, flowExecutor })], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "summarize this");
  faux.unregister();

  const r = toolResultText(result.messages, "skill_summarizer");
  check("flow-skill: executor received the rendered skill body", seenInstructions.includes("one-line summary"));
  check("flow-skill: sub-Runner output returned as tool result", !r.isError && r.text.includes("SUMMARY: compressed."));
  check("flow-skill: main relays the summary", result.output.includes("relayed the summary"));
}

async function testSessionSkillService(machine: LocalMachine, roots: readonly SkillRoot[]): Promise<void> {
  const events = new ListenerSink();
  const steer = new SteerBus();
  let activated: AgentEvent | undefined;
  events.subscribe((event) => {
    if (event.type === "skill.activated") activated = event;
  });

  const session = await Session.open({
    machine,
    events,
    steer,
    capabilities: [skillsCapability({ roots })],
  });
  try {
    const skills = await session.listSkills();
    const result = await session.activateSkill("greeter", "World");
    const steered = steer.drainSteering().map((s) => s.message);
    const text = steered
      .flatMap((m) => m.content)
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");

    check("session skills: listSkills exposes the scanned catalog", skills.some((skill) => skill.name === "greeter"));
    check("session skills: activateSkill returns activation metadata", result.skillName === "greeter" && result.skillArgs === "World" && typeof result.turnId === "string");
    check("session skills: activateSkill emits skill.activated", activated?.type === "skill.activated" && activated.skillName === "greeter" && activated.trigger === "user-slash");
    check("session skills: activation enters steer queue as a system reminder", text.includes('<system-reminder>\n<skill-loaded name="greeter" args="World">') && text.includes("Greeting for World."));
  } finally {
    await session.close();
  }
}

/**
 * Plugin skill dirs must ADD to the default project/user roots, never replace them: a host that
 * hands over one skill-bearing plugin used to silently hide every `.agents/skills` skill.
 */
async function testDefaultRootsMerge(machine: LocalMachine, dir: string): Promise<void> {
  const projectDir = join(dir, "project");
  const userHomeDir = join(dir, "user");
  const pluginSkills = join(dir, "plugin", "skills");
  writeSkill(join(pluginSkills, "tracker"), "SKILL.md", "name: tracker\ndescription: Plugin-provided issue tracker.", "tracker body");
  // Same name as the project skill → the default roots come first, so project still wins.
  writeSkill(join(pluginSkills, "dup"), "SKILL.md", "name: dup\ndescription: Plugin version of dup.", "plugin dup body");
  const pluginRoots: readonly SkillRoot[] = [{ path: pluginSkills, source: "extra", plugin: { id: "tracker-plugin" } }];

  const replaced = await resolveSkillRoots(machine, { explicitRoots: pluginRoots, projectDir, userHomeDir });
  check(
    "roots: explicit roots replace the defaults by default",
    JSON.stringify(replaced.map((r) => r.source)) === JSON.stringify(["extra"]),
  );

  const merged = await resolveSkillRoots(machine, { explicitRoots: pluginRoots, projectDir, userHomeDir, includeDefaults: true });
  check(
    "roots: includeDefaults keeps project + user roots ahead of the explicit ones",
    JSON.stringify(merged.map((r) => r.source)) === JSON.stringify(["project", "user", "extra"]),
  );

  const registry = new SkillRegistry();
  await registry.loadRoots(machine, merged);
  check("roots: merged scan sees both local and plugin skills", registry.getSkill("greeter") !== undefined && registry.getSkill("tracker") !== undefined);
  check("roots: local skill still shadows the same-named plugin skill", registry.getSkill("dup")?.source === "project");
  check("roots: plugin provenance preserved through the merge", registry.getSkill("tracker")?.plugin?.id === "tracker-plugin");

  // Same thing through the capability, which is how a harness actually wires plugin roots in.
  const session = await Session.open({
    machine,
    events: new ListenerSink(),
    steer: new SteerBus(),
    capabilities: [skillsCapability({ roots: pluginRoots, includeDefaultRoots: true, projectDir, userHomeDir })],
  });
  try {
    const names = (await session.listSkills()).map((s) => s.name);
    check("roots: skillsCapability({ includeDefaultRoots }) loads local + plugin skills", names.includes("greeter") && names.includes("tracker"));
  } finally {
    await session.close();
  }

  const isolated = await Session.open({
    machine,
    events: new ListenerSink(),
    steer: new SteerBus(),
    capabilities: [skillsCapability({ roots: pluginRoots, projectDir, userHomeDir })],
  });
  try {
    const names = (await isolated.listSkills()).map((s) => s.name);
    check("roots: without the flag the capability stays isolated to its roots", names.includes("tracker") && !names.includes("greeter"));
  } finally {
    await isolated.close();
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-skills-e2e-"));
  const machine = new LocalMachine(dir);
  const { roots } = buildSkillTree(dir);
  try {
    await testScanAndPrecedence(machine, roots);
    await testCatalogInjection(machine, roots);
    await testSkillToolInline(machine, roots);
    await testUserOnlyRefused(machine, roots);
    await testFlowSkillSubRunner(machine, roots);
    await testSessionSkillService(machine, roots);
    await testDefaultRootsMerge(machine, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SKILLS E2E PASS — scan/precedence + catalog inject + inline load + user-only guard + flow sub-Runner");
  } else {
    console.log("❌ SKILLS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ SKILLS E2E ERROR:", error);
  process.exit(1);
});
