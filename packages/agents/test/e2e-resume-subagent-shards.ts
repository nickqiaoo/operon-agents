/**
 * Resuming a session whose log holds subagent shards: the main agent's context must be main's
 * shard alone.
 *
 * The log is one append stream for every frame. Opening a session reads it whole (capabilities
 * fold goal/plan/todo across all addresses) and reuses that read to pre-build main's live
 * context. That pre-build used to fold every record in — so after a resume each worker's turns
 * sat in the main agent's history, and with parallel dispatches they landed between main's
 * tool call and its result: the provider then saw a call with no result followed by a stray
 * one, and every later request was rejected.
 *
 * The interleaving is planted rather than raced: parallel workers writing between a call and
 * its result is what a live run does, but timing it on purpose would need a fake clock.
 */
import { fauxAssistantMessage, registerFauxProvider, type Context } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import { MemorySessionRepository, type Message, type SessionStore } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function storeOf(repo: MemorySessionRepository, id: string): Promise<SessionStore> {
  const handle = await repo.open(id);
  if (handle === undefined) throw new Error(`session ${id} not found in repository`);
  return handle.store;
}

function textOf(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function append(store: SessionStore, address: string, message: Message): Promise<void> {
  await store.appendRecord({ time: Date.now(), address, type: "context.append_message", message });
}

async function resumeKeepsOnlyMainShard(): Promise<void> {
  const faux = registerFauxProvider();
  let seen: Context["messages"] = [];
  faux.setResponses([
    fauxAssistantMessage("hi", { stopReason: "stop" }),
    (context) => {
      seen = context.messages;
      return fauxAssistantMessage("back again", { stopReason: "stop" });
    },
  ]);
  const repo = new MemorySessionRepository();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, harness: () => ({ sessionRepository: repo }) });
  const session = await harness.createSession();
  await session.prompt("hello");
  const sessionId = session.id;
  await session.close();

  // Main dispatches two workers in one message; both write their shards before main's results land.
  const store = await storeOf(repo, sessionId);
  const now = Date.now();
  await append(store, "main", {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_a", name: "Agent", arguments: { prompt: "task a" } },
      { type: "toolCall", id: "call_b", name: "Agent", arguments: { prompt: "task b" } },
    ],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: now,
  } as Message);
  await append(store, "main/worker-a", { role: "user", content: [{ type: "text", text: "worker a prompt" }], timestamp: now });
  await append(store, "main/worker-b", { role: "user", content: [{ type: "text", text: "worker b prompt" }], timestamp: now });
  await append(store, "main/worker-a", fauxAssistantMessage("worker a private notes") as Message);
  for (const id of ["call_a", "call_b"]) {
    await append(store, "main", {
      role: "toolResult",
      toolCallId: id,
      toolName: "Agent",
      content: [{ type: "text", text: `started ${id}` }],
      isError: false,
      timestamp: now,
    } as Message);
  }

  const reopened = await harness.resumeSession(sessionId);
  await reopened.prompt("anything new?");
  const texts = seen.map((m) => textOf(m as Message));
  check("resume: no worker message reached the main agent", !texts.some((t) => t.includes("worker a") || t.includes("worker b")));
  const results = seen.filter((m) => m.role === "toolResult");
  check("resume: one result per dispatch, nothing synthesized", results.length === 2);
  const callIndex = seen.findIndex((m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.id === "call_a"));
  check(
    "resume: the dispatch's results follow it directly",
    callIndex >= 0 && seen[callIndex + 1]?.role === "toolResult" && seen[callIndex + 2]?.role === "toolResult",
  );
  check("resume: main's own earlier turn is still there", texts.includes("hello") && texts.includes("hi"));

  await reopened.close();
  faux.unregister();
}

await resumeKeepsOnlyMainShard();

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
