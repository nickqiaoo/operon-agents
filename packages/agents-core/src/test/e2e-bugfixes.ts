import { testRunner, openTestSession } from "./faux.ts";
/**
 * Regression suite for four durable-state bugs:
 *
 *  1. Same-named agents: `findAgentByName` used to bind whichever BFS found first (and a
 *     name-keyed visited set pruned the duplicate's subtree). Now: fail-closed
 *     AmbiguousAgentNameError, full identity-keyed traversal, and the warm head-cache
 *     path falls back to the (edge-correct) cold walk under duplicate names.
 *  2. Static `agent_<name>` sub-agents used a FIXED `<parent>/<name>` shard, so repeated
 *     calls re-seeded one shared shard and replay mixed their transcripts. Now: a
 *     per-instance shard (`<parent>/<name>-<hex>`) with a subagent_meta record, like the
 *     unified Agent tool.
 *  3. MemorySessionRepository.fork copied only 3 hardcoded KV keys (bg:*, goal, … lost).
 *     Now: listStateKeys() on every backend + full-state copy on fork.
 *  4. LogSessionStore.rewrite stamped missing leading metadata with address "main" for
 *     EVERY shard. Now: the shard's own address, and an existing wrong-address metadata
 *     (stamped by the old bug) is corrected in place.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  defineTool,
  handoff,
  Runner,
  Session,
  LocalMachine,
  ListenerSink,
  MemoryStore,
  DiskSessionStore,
  MemorySessionRepository,
  replayContext,
  type AgentEvent,
  type AgentRecord,
} from "../index.ts";
import { WIRE_PROTOCOL_VERSION } from "../internal.ts";
import type { SubagentProvider } from "../agent/profiles.ts";
import {
  AmbiguousAgentNameError,
  duplicateAgentNames,
  findAgentByName,
  findAgentsByName,
} from "../agent/graph.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function collect(it: AsyncIterable<AgentRecord>): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of it) out.push(record);
  return out;
}

// ── 1. Same-named agents: graph resolution ───────────────────────────────────────────────

function testGraphAmbiguity(): void {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const hidden = defineAgent({ name: "hidden", model, instructions: "x" });
  const dupA = defineAgent({ name: "dup", model, instructions: "A" });
  const dupB = defineAgent({ name: "dup", model, instructions: "B", subagents: [hidden] });
  const mid = defineAgent({ name: "mid", model, instructions: "x", subagents: [dupB] });
  const root = defineAgent({ name: "root", model, instructions: "x", subagents: [dupA, mid] });

  const matches = findAgentsByName(root, "dup");
  check("graph: findAgentsByName returns BOTH distinct same-named agents", matches.length === 2 && matches.includes(dupA) && matches.includes(dupB));

  let thrown: unknown;
  try {
    findAgentByName(root, "dup");
  } catch (error) {
    thrown = error;
  }
  check("graph: findAgentByName fails closed on an ambiguous name", thrown instanceof AmbiguousAgentNameError && thrown.agentName === "dup");

  // Old traversal (visited keyed by NAME) pruned dupB's subtree, hiding `hidden` entirely.
  check("graph: subtree behind a same-named duplicate is still traversed", findAgentByName(root, "hidden") === hidden);
  check("graph: unique names resolve as before", findAgentByName(root, "mid") === mid);
  check("graph: duplicateAgentNames reports exactly the clashing names", JSON.stringify(duplicateAgentNames(root)) === JSON.stringify(["dup"]));
  check("graph: duplicateAgentNames is empty for a clean graph", duplicateAgentNames(mid).length === 0 && duplicateAgentNames(dupA).length === 0);
  faux.unregister();
}

// ── 1b. Same-named agents: warm head cache falls back to the cold edge walk ──────────────

async function testHeadCacheDuplicateFallback(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { reason: "route" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("billing reply one", { stopReason: "stop" }),
    fauxAssistantMessage("billing reply two", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;

  interface Ctx {
    readonly visited: string[];
  }
  // Two DISTINCT agents both named "billing": the handoff target (A) and a decoy (B)
  // parked behind another agent. Legal graph — they never collide on one agent's edges.
  const billingA = defineAgent<Ctx>({
    name: "billing",
    model,
    instructions: ({ context }) => {
      context?.visited.push("A");
      return "Handle billing (real).";
    },
  });
  const billingB = defineAgent<Ctx>({
    name: "billing",
    model,
    instructions: ({ context }) => {
      context?.visited.push("B");
      return "Handle billing (decoy).";
    },
  });
  const aux = defineAgent<Ctx>({ name: "aux", model, instructions: "x", subagents: [billingB] });
  const main = defineAgent<Ctx>({
    name: "main",
    model,
    instructions: "Route.",
    handoffs: [handoff(billingA)],
    subagents: [aux],
  });

  const store = new MemoryStore();
  const events = new ListenerSink();
  const warnings: string[] = [];
  events.subscribe((event: AgentEvent) => {
    if (event.type === "warning") warnings.push(event.message);
  });
  const session = await openTestSession({ machine, store, events });
  const ctx: Ctx = { visited: [] };
  const runner = testRunner<Ctx>({ machine });

  const first = await runner.run(main, "I need billing", { session, context: ctx });
  check("dup fallback: turn 1 hands off to the real billing agent", first.finalAgent === "billing" && ctx.visited.includes("A") && !ctx.visited.includes("B"));

  // Turn 2 hits the warm head cache: {agentKey:"billing"} matches TWO objects, so the
  // cache must be bypassed for the cold edge walk — which can only reach billingA.
  const before = ctx.visited.length;
  const second = await runner.run(main, "follow-up", { session, context: ctx });
  const turn2 = ctx.visited.slice(before);
  check("dup fallback: turn 2 completes instead of binding by name", second.status === "completed" && second.output.includes("billing reply two"));
  check("dup fallback: turn 2 ran the edge-correct agent, never the decoy", turn2.includes("A") && !turn2.includes("B"));
  check("dup fallback: run boundary warns about the duplicate name", warnings.some((w) => w.includes("duplicate agent names") && w.includes("billing")));

  await session.close();
  faux.unregister();
}

// ── 2. Static sub-agent per-instance shards ──────────────────────────────────────────────

async function testStaticSubagentPerInstanceShard(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("agent_researcher", { input: "task one" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("answer one", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("agent_researcher", { input: "task two" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("answer two", { stopReason: "stop" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const researcher = defineAgent({ name: "researcher", model, instructions: "Research." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [researcher] });

  const store = new MemoryStore();
  const runner = testRunner({ machine, store });
  const result = await runner.run(main, "do both tasks");
  faux.unregister();

  check("static subagent: parent run completes", result.status === "completed");

  const childAddresses = (await store.listAddresses()).filter((a) => /^main\/researcher-[0-9a-f]+$/.test(a));
  check("static subagent: two calls → two distinct per-instance shards", childAddresses.length === 2);
  check("static subagent: fixed shared shard 'main/researcher' is gone", !(await store.listAddresses()).includes("main/researcher"));

  // Each shard replays to ONLY its own conversation — the exact property the fixed
  // shared address violated (replay used to reduce both seeds into one transcript).
  const replays = await Promise.all(childAddresses.map((address) => replayContext(store, address)));
  const promptsOf = (history: readonly { role: string; content: readonly { type: string }[] }[]): string =>
    JSON.stringify(history.filter((m) => m.role === "user"));
  const isolated = replays.every((replay) => {
    const prompts = promptsOf(replay.history);
    return (prompts.includes("task one") ? 1 : 0) + (prompts.includes("task two") ? 1 : 0) === 1;
  });
  check("static subagent: each shard replays only its own transcript", isolated);

  const metas = await Promise.all(
    childAddresses.map(async (address) => {
      const records = await collect(store.readRecords({ address }));
      return records.find((record) => record.type === "custom" && record.name === "subagent_meta");
    }),
  );
  check(
    "static subagent: each shard carries a resumable subagent_meta record",
    metas.every(
      (meta, i) =>
        meta?.type === "custom" &&
        (meta.data as { agentId?: string; type?: string }).type === "researcher" &&
        `main/${(meta.data as { agentId?: string }).agentId}` === childAddresses[i],
    ),
  );
  check(
    "static subagent: meta records the parent address + tool call",
    metas.every((meta) => {
      if (meta?.type !== "custom") return false;
      const data = meta.data as { parentAddress?: string; parentToolCallId?: string };
      return data.parentAddress === "main" && typeof data.parentToolCallId === "string" && data.parentToolCallId.length > 0;
    }),
  );
}

// ── 3. Memory fork copies the FULL KV state ──────────────────────────────────────────────

async function testMemoryForkFullState(): Promise<void> {
  const repo = new MemorySessionRepository();
  const source = await repo.create({ workDir: "/tmp/fork-src" });
  await source.store.appendRecord({ address: "main", type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  await source.store.putState("interrupt", { i: 1 });
  await source.store.putState("bg:index", ["t1"]);
  await source.store.putState("bg:task:t1", { status: "running" });
  await source.store.putState("goal", { text: "ship it" });
  await source.store.putState("tasklist:hwm", 7);

  const forked = await repo.fork(source.id);
  const key = async (k: string): Promise<unknown> => forked.store.getState(k);
  check(
    "memory fork: bg:* / goal / tasklist keys survive (not just the 3 hardcoded ones)",
    JSON.stringify(await key("bg:index")) === JSON.stringify(["t1"]) &&
      JSON.stringify(await key("bg:task:t1")) === JSON.stringify({ status: "running" }) &&
      JSON.stringify(await key("goal")) === JSON.stringify({ text: "ship it" }) &&
      (await key("tasklist:hwm")) === 7 &&
      JSON.stringify(await key("interrupt")) === JSON.stringify({ i: 1 }),
  );
  const meta = (await forked.store.getState("meta")) as { id: string } | null;
  check("memory fork: meta keeps the fork's own id (not the source's)", meta?.id === forked.id && forked.id !== source.id);
  const records = await collect(forked.store.readRecords({ address: "main" }));
  check("memory fork: log records still copied", records.some((r) => r.type === "context.append_message"));

  const keys = await source.store.listStateKeys?.();
  check("memory store: listStateKeys enumerates every key", keys !== undefined && ["meta", "interrupt", "bg:index", "bg:task:t1", "goal", "tasklist:hwm"].every((k) => keys.includes(k)));
}

async function testDiskListStateKeys(root: string): Promise<void> {
  const store = new DiskSessionStore(join(root, "disk-keys"));
  await store.putState("goal", { g: 1 });
  await store.putState("bg:index", []);
  const keys = await store.listStateKeys();
  check("disk store: listStateKeys enumerates state.json keys", keys.includes("goal") && keys.includes("bg:index"));
}

// ── 4. rewrite stamps the shard's OWN address into leading metadata ──────────────────────

/** MemoryStore with raw line injection: builds shards that bypass appendRecord's
 *  auto-metadata, reproducing logs written by older versions. */
class RawInjectMemoryStore extends MemoryStore {
  async injectRaw(address: string, line: string): Promise<void> {
    await this.appendLine(address, line);
  }
}

async function testRewriteMetadataAddress(): Promise<void> {
  const store = new RawInjectMemoryStore();

  // A raw pre-sequence shard with no metadata is outside the new storage contract. Rewrite
  // preserves its surviving record rather than inventing a leading record with no valid
  // earlier sequence; normal appendRecord() always stamps metadata before data.
  await store.injectRaw("main/sub", JSON.stringify({ time: 1, address: "main/sub", type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));
  await store.rewrite("main/sub");
  const sub = await collect(store.readRecords({ address: "main/sub" }));
  check("rewrite: does not renumber raw content to invent metadata", sub.length === 1 && sub[0]?.type === "context.append_message");
  check("rewrite: raw shard content remains readable", sub[0]?.address === "main/sub");

  // Shard already corrupted by the old bug (leading metadata says "main"): healed in place.
  await store.injectRaw("main/sub2", JSON.stringify({ type: "metadata", protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1, time: 1, address: "main" }));
  await store.injectRaw("main/sub2", JSON.stringify({ time: 2, address: "main/sub2", type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "yo" }] } }));
  await store.rewrite("main/sub2");
  const sub2 = await collect(store.readRecords({ address: "main/sub2" }));
  const metadataCount = sub2.filter((r) => r.type === "metadata").length;
  check("rewrite: wrong-address leading metadata is corrected, not duplicated", sub2[0]?.type === "metadata" && sub2[0].address === "main/sub2" && metadataCount === 1);

  // The default shard keeps its (already correct) metadata untouched.
  await store.appendRecord({ address: "main", type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "root" }] } });
  await store.rewrite("main");
  const main = await collect(store.readRecords({ address: "main" }));
  check("rewrite: 'main' shard metadata still says main", main[0]?.type === "metadata" && main[0].address === "main");
}

// ── outputType parse failures carry the reason (were silently swallowed) ─────────────────

async function testOutputParseError(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("not json at all", { stopReason: "stop" }),
    fauxAssistantMessage('{"answer": 42}', { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "typed", model, instructions: "x", outputType: z.object({ answer: z.number() }) });
  const events = new ListenerSink();
  const warnings: string[] = [];
  events.subscribe((event: AgentEvent) => {
    if (event.type === "warning") warnings.push(event.message);
  });
  const runner = testRunner({ machine, events });
  const bad = await runner.run(agent, "one");
  const good = await runner.run(agent, "two");
  faux.unregister();

  check(
    "outputParse: schema rejection surfaces outputParseError (not a bare undefined)",
    bad.outputParsed === undefined && typeof bad.outputParseError === "string" && bad.outputParseError.length > 0,
  );
  check("outputParse: rejection emits a warning event", warnings.some((w) => w.includes("outputType rejected")));
  check(
    "outputParse: success parses with no error set",
    good.outputParseError === undefined && JSON.stringify(good.outputParsed) === JSON.stringify({ answer: 42 }),
  );
}

// ── provider agents shadowed by static subagents warn (were silently dropped) ────────────

async function testProviderShadowWarning(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", { text: "one" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const echoTool = defineTool({
    name: "echo",
    description: "echo",
    params: z.object({ text: z.string() }),
    resolve: (args) => ({ approvalRule: "echo", run: async () => ({ content: [{ type: "text" as const, text: args.text }] }) }),
  });
  const researcher = defineAgent({ name: "researcher", model, instructions: "static" });
  const main = defineAgent({ name: "main", model, instructions: "x", subagents: [researcher], tools: [echoTool] });
  const provider: SubagentProvider = {
    list: () => [
      { name: "researcher", description: "provider duplicate — must be shadowed" },
      { name: "extra", description: "unique — must stay available" },
    ],
    get: () => undefined,
  };
  const events = new ListenerSink();
  const shadowWarnings: string[] = [];
  events.subscribe((event: AgentEvent) => {
    if (event.type === "warning" && event.message.includes("shadowed")) shadowWarnings.push(event.message);
  });
  const runner = testRunner({ machine, events, subagentProvider: provider, permission: { mode: "yolo" } });
  const result = await runner.run(main, "go");
  faux.unregister();

  check("shadow: run completes", result.status === "completed");
  check("shadow: warning names the shadowed provider type", shadowWarnings.length > 0 && shadowWarnings[0]!.includes('"researcher"'));
  // The echo tool call makes this a 2-turn run → the toolset is built twice on the same
  // frame; without dedupe the warning would repeat per turn.
  check("shadow: warned exactly once per frame across turns", shadowWarnings.length === 1);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-bugfixes-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    testGraphAmbiguity();
    await testHeadCacheDuplicateFallback(machine);
    await testStaticSubagentPerInstanceShard(machine);
    await testMemoryForkFullState();
    await testDiskListStateKeys(dir);
    await testRewriteMetadataAddress();
    await testOutputParseError(machine);
    await testProviderShadowWarning(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ BUGFIXES E2E PASS — ambiguous-name fail-closed + head-cache fallback + per-instance static subagent shards + full-state memory fork + rewrite metadata address + outputParseError + provider-shadow warning");
  } else {
    console.log("❌ BUGFIXES E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ BUGFIXES E2E ERROR:", error);
  process.exit(1);
});
