import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  buildAgentFromProfile,
  DiskSessionStore,
  defineAgent,
  defineModel,
  loadAgentProfiles,
  type Message,
  profileSubagentProvider,
  replayContext,
  Runner,
  Session,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}
function texts(history: readonly Message[]): string {
  return history.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("|");
}
function agentIdOf(messages: readonly Message[]): string | undefined {
  return /agent_id: ([a-zA-Z0-9_-]+)/.exec(JSON.stringify(messages))?.[1];
}

// ── A+B+C: spawn returns an id, resume reloads the SAME shard and continues it ──
async function testResume(root: string): Promise<void> {
  const store = new DiskSessionStore(join(root, "resume"));
  const session = await Session.open({ store });
  const runner = new Runner({});
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const researcher = defineAgent({ name: "researcher", model, instructions: "Research and remember." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [researcher] });

  // Run 1 — spawn the researcher.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "researcher", prompt: "Note that the code is 4242.", description: "note code" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Noted: the code is 4242.", { stopReason: "stop" }),
    fauxAssistantMessage("Subagent finished.", { stopReason: "stop" }),
  ]);
  const r1 = await runner.run(main, "spawn researcher", { session });
  const agentId = agentIdOf(r1.messages);
  check("spawn: run completes", r1.status === "completed");
  check("spawn: returns a per-instance agent_id", agentId !== undefined && /^researcher-[0-9a-f]+$/.test(agentId));

  // A foreground subagent is a plain Agent tool call, not a background task — so it is NOT
  // listed as a subagent task. Its record is the conversation + its own shard (resumable by id).
  const subs1 = await session.listSubagents();
  check("foreground subagent is a tool call — not listed as a task", subs1.length === 0);

  const shard = `main/${agentId}`;
  const after1 = texts((await replayContext(store, shard)).history);
  check("spawn: subagent journaled to its own shard", after1.includes("the code is 4242") && after1.includes("Note that the code is 4242."));

  // Run 2 — resume the SAME subagent by id with a follow-up prompt.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { resume: agentId, prompt: "What was the code?", description: "recall" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The code was 4242.", { stopReason: "stop" }),
    fauxAssistantMessage("Recalled.", { stopReason: "stop" }),
  ]);
  const r2 = await runner.run(main, "resume researcher", { session });
  faux.unregister();
  check("resume: run completes", r2.status === "completed");

  const after2 = texts((await replayContext(store, shard)).history);
  check("resume: continues the SAME shard (original history kept)", after2.includes("Note that the code is 4242."));
  check("resume: appends the follow-up prompt + answer", after2.includes("What was the code?") && after2.includes("The code was 4242."));

  // Resume reloaded the shard by id (via the shard's own meta record) with no registry/fold;
  // it stays a foreground tool call, so still not listed as a task.
  const subs2 = await session.listSubagents();
  check("resume of a foreground subagent stays a tool call — not listed", subs2.length === 0);

  await session.close();
}

// ── Error: resuming an unknown id is reported, not crashed ──
async function testUnknownId(root: string): Promise<void> {
  const store = new DiskSessionStore(join(root, "unknown"));
  const session = await Session.open({ store });
  const runner = new Runner({});
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const sub = defineAgent({ name: "researcher", model, instructions: "x" });
  const main = defineAgent({ name: "main", model, instructions: "x", subagents: [sub] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { resume: "researcher-deadbeef", prompt: "go", description: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Could not resume.", { stopReason: "stop" }),
  ]);
  const r = await runner.run(main, "resume nothing", { session });
  faux.unregister();
  await session.close();
  check("error: unknown agent id reported to the model", /Unknown agent id/.test(JSON.stringify(r.messages)));
}

// ── Error: resume without a durable store is refused (foundation requires persistence) ──
async function testNoStore(): Promise<void> {
  const runner = new Runner({}); // owned session, no store
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const sub = defineAgent({ name: "researcher", model, instructions: "x" });
  const main = defineAgent({ name: "main", model, instructions: "x", subagents: [sub] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { resume: "researcher-1", prompt: "go", description: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("No store.", { stopReason: "stop" }),
  ]);
  const r = await runner.run(main, "resume without store");
  faux.unregister();
  check("error: resume without a durable store is refused", /requires a durable session store/.test(JSON.stringify(r.messages)));
}

// ── D: profiles — load agent defs from disk, build them, spawn via a runtime provider ──
async function testProfiles(root: string): Promise<void> {
  const homeDir = join(root, "prof-home");
  const cwd = join(root, "prof-cwd");
  const profileDir = join(cwd, ".agents", "agents");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "analyst.yaml"), `name: analyst\nsystemPromptTemplate: "Analyze carefully. cwd={{ workDir }}"\nmodel: faux/test\nwhenToUse: Data analyst\n`);

  const opts = { appName: "agents", homeDir, cwd };
  const profiles = await loadAgentProfiles(opts);
  check("profile: loaded from disk (YAML)", profiles["analyst"] !== undefined && profiles["analyst"]!.name === "analyst");

  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const store = new DiskSessionStore(join(root, "prof-store"));
  const session = await Session.open({ store });
  const built = await buildAgentFromProfile(profiles["analyst"]!, { resolveModel: async () => model });
  const rendered = await built.resolveInstructions({
    sessionId: "t",
    address: "main",
    signal: new AbortController().signal,
    machine: session.machine,
    resolveSystemPromptContext: () => session.resolveSystemPromptContext(session.machine),
  });
  check("profile: builds a runnable Agent with a rendered system prompt", built.name === "analyst" && (rendered ?? "").includes("Analyze carefully."));

  const provider = profileSubagentProvider(profiles, { resolveModel: async () => model });
  check("profile: provider lists the agent", (await provider.list()).some((a) => a.name === "analyst"));

  // The model spawns a profile-based subagent type that was never statically declared.
  const runner = new Runner({ subagentProvider: provider });
  const mainAgent = defineAgent({ name: "main", model, instructions: "Coordinate." }); // no static subagents
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "analyst", prompt: "Analyze the data.", description: "analyze" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Analysis complete.", { stopReason: "stop" }),
    fauxAssistantMessage("Reported.", { stopReason: "stop" }),
  ]);
  const r = await runner.run(mainAgent, "use the analyst", { session });
  faux.unregister();
  const analystId = agentIdOf(r.messages);
  check(
    "profile: spawned a profile-based subagent via the provider",
    r.status === "completed" && analystId !== undefined && /^analyst-[0-9a-f]+$/.test(analystId),
  );
  await session.close();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-subagent-e2e-"));
  try {
    await testResume(root);
    await testUnknownId(root);
    await testNoStore();
    await testProfiles(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SUBAGENT E2E PASS — per-instance agent_id + resume via shard meta (no fold) + foreground stays a tool call + error handling");
  } else {
    console.log("❌ SUBAGENT E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ SUBAGENT E2E ERROR:", error);
  process.exit(1);
});
