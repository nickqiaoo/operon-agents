/**
 * The stateless-server contract, part 2 — what a request-per-turn backend actually hits.
 *
 *  A. tool calls and their results replay into the next request
 *  B. a durable interrupt raised in one request resumes in another, re-running nothing
 *  C. two concurrent requests for one session fork their views when no lock is configured
 *  D. the same race with `RunnerConfig.lock` — the loser is rejected, not admitted
 *
 * See `e2e-stateless-server.ts` for the basic shape this builds on.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineAgent,
  defineTool,
  MemorySessionLock,
  filesystemTools,
  getInterruptionState,
  DiskSessionRepository,
  LocalMachine,
  Runner,
} from "../index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxResponseStep,
} from "./faux.ts";

const root = mkdtempSync(join(tmpdir(), "stateless-hard-"));
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const repository = new DiskSessionRepository(root);
const faux = registerFauxProvider();
const model = faux.getChatModel()!;

async function request<T>(id: string, fn: (runner: Runner, workDir: string) => Promise<T>): Promise<T> {
  const opened = await repository.open(id);
  if (!opened) throw new Error(`no such session: ${id}`);
  try {
    return await fn(
      new Runner({
        store: opened.store,
        machine: new LocalMachine(opened.workDir),
        permission: { mode: "yolo" },
      }),
      opened.workDir,
    );
  } finally {
    await opened.store.close?.();
  }
}

async function newSession(): Promise<string> {
  const created = await repository.create({ workDir: work, ownerKey: "t" });
  await created.store.close?.();
  return created.id;
}

// ── A. tool calls, then a follow-up request that must see the tool result ────────
async function toolsAcrossRequests(): Promise<void> {
  const id = await newSession();
  writeFileSync(join(work, "note.txt"), "the answer is 42\n");
  const agent = defineAgent({ name: "a", instructions: "Use tools.", model, tools: filesystemTools() });

  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("Read", { file_path: join(work, "note.txt") }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("It says 42.", { stopReason: "stop" }),
  ]);
  const r1 = await request(id, (runner) => runner.run(agent, "read note.txt", { sessionId: id }));
  assert.equal(r1.status, "completed", `A/run1: ${r1.status}`);

  let sawToolResult = false;
  const capture: FauxResponseStep = (context) => {
    sawToolResult = context.messages.some((m) => m.role === "toolResult");
    return fauxAssistantMessage("42.", { stopReason: "stop" });
  };
  faux.setResponses([capture]);
  const r2 = await request(id, (runner) => runner.run(agent, "what did it say?", { sessionId: id }));
  assert.equal(r2.status, "completed", `A/run2: ${r2.status}`);
  assert.ok(sawToolResult, "A: tool result did not survive into the next request");
  console.log("A OK — tool calls and their results replay across requests");
}

// ── B. interrupt in one request, resume in another ───────────────────────────────
/** Two-phase tool: the expensive half must NOT re-run when a later request resumes it. */
function makeConfirmTool(counters: { searches: number; books: number }) {
  return defineTool({
    name: "pick",
    description: "search, ask the user to choose, then book",
    params: z.object({ topic: z.string() }),
    resolve: (args) => ({
      approvalRule: `pick(${args.topic})`,
      run: async (ctx) => {
        if (ctx.resumed) {
          counters.books++;
          const { choice } = ctx.resumed.answer as { choice: string };
          return { content: [{ type: "text" as const, text: `booked:${choice}` }] };
        }
        counters.searches++;
        ctx.suspend(
          { kind: "choice", display: { title: `pick one ${args.topic}` } },
          { topic: args.topic },
        );
      },
    }),
  });
}

async function interruptAcrossRequests(): Promise<void> {
  const id = await newSession();
  const counters = { searches: 0, books: 0 };
  const agent = defineAgent({ name: "b", instructions: "x", model, tools: [makeConfirmTool(counters)] });

  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("pick", { topic: "flight" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Booked it.", { stopReason: "stop" }),
  ]);

  // Request 1 — pauses. The process could die right here.
  const paused = await request(id, (runner) => runner.run(agent, "book a flight", { sessionId: id }));
  assert.equal(paused.status, "interrupted", `B/run1 status: ${paused.status}`);
  const pending = paused.interruptions![0]!;
  const state = getInterruptionState(paused)!;
  assert.ok(state, "B: no resume-ready interruption state on the RunResult");

  // Request 2 — a fresh Runner, a fresh Session, only the store in between.
  const resumed = await request(id, (runner) =>
    runner.resume(agent, {
      interruption: state,
      answers: { [pending.approvalId]: { kind: "input", data: { choice: "flight-A" } } },
    }, { sessionId: id }),
  );
  assert.equal(resumed.status, "completed", `B/resume status: ${resumed.status}`);
  assert.equal(counters.searches, 1, "B: expensive phase re-ran on resume");
  assert.equal(counters.books, 1, "B: resumed half did not run exactly once");
  console.log("B OK — interrupted in request 1, resumed in request 2, no work re-done");
}

// ── C. two concurrent requests, same session id ──────────────────────────────────
/**
 * Without a lock this forks, and that is not a bug in the store — `withRunLock` guards ONE
 * Session object, and per-request Runners each build their own, so both runs proceed and each
 * replays history from before the other's write. Nothing is lost; the two views simply diverge.
 *
 * `RunnerConfig.lock` is the fix, and this covers both halves: the fork is still what happens
 * when no lock is configured (so the default path is pinned, not accidentally changed), and a
 * lock turns the loser into a `SessionBusyError` instead.
 */
async function concurrentRequestsForkWithoutALock(): Promise<void> {
  const id = await newSession();
  const agent = defineAgent({ name: "c", instructions: "x", model });
  faux.setResponses([() => fauxAssistantMessage("seeded", { stopReason: "stop" })]);
  await request(id, (runner) => runner.run(agent, "turn zero", { sessionId: id }));

  const views: string[][] = [];
  const capture = (label: string): FauxResponseStep => (context) => {
    views.push(context.messages.map((m) => (m.role === "user" ? userText(m) : m.role)));
    return fauxAssistantMessage(label, { stopReason: "stop" });
  };
  faux.setResponses([capture("A"), capture("B")]);

  const outcomes = await Promise.allSettled([
    request(id, (runner) => runner.run(agent, "concurrent-A", { sessionId: id })),
    request(id, (runner) => runner.run(agent, "concurrent-B", { sessionId: id })),
  ]);
  assert.ok(
    outcomes.every((o) => o.status === "fulfilled"),
    "C: with no lock configured, both runs are expected to be admitted",
  );
  assert.ok(
    views.every((v) => !(v.includes("concurrent-A") && v.includes("concurrent-B"))),
    `C: expected forked views, got ${JSON.stringify(views)}`,
  );

  // Forked views, but no lost write: both turns are in the durable log.
  const reopened = await repository.open(id);
  const page = await reopened!.store.readRecordPage({ limit: 200 });
  await reopened!.store.close?.();
  const users = page.data.filter((r) => (r.record as Rec).message?.role === "user").length;
  assert.equal(users, 3, `C: expected all 3 user turns durable, saw ${users}`);
  console.log("C OK — without a lock, concurrent requests fork the view but lose no writes");
}

// ── D. the same race, with a lock configured ─────────────────────────────────────
async function aLockSerializesTheSameRace(): Promise<void> {
  const id = await newSession();
  const agent = defineAgent({ name: "d", instructions: "x", model });
  // One lock instance shared by both "requests" — the single-process stand-in for a lease table.
  const lock = new MemorySessionLock();
  const locked = async <T>(fn: (runner: Runner) => Promise<T>): Promise<T> => {
    const opened = await repository.open(id);
    if (!opened) throw new Error(`no such session: ${id}`);
    try {
      return await fn(new Runner({
        store: opened.store,
        machine: new LocalMachine(opened.workDir),
        permission: { mode: "yolo" },
        lock,
      }));
    } finally {
      await opened.store.close?.();
    }
  };

  const views: string[][] = [];
  const capture = (label: string): FauxResponseStep => (context) => {
    views.push(context.messages.map((m) => (m.role === "user" ? userText(m) : m.role)));
    return fauxAssistantMessage(label, { stopReason: "stop" });
  };
  faux.setResponses([capture("A"), capture("B")]);

  const outcomes = await Promise.allSettled([
    locked((runner) => runner.run(agent, "locked-A", { sessionId: id })),
    locked((runner) => runner.run(agent, "locked-B", { sessionId: id })),
  ]);
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(rejected.length, 1, `D: expected exactly one loser, got ${JSON.stringify(outcomes.map((o) => o.status))}`);
  const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
  assert.equal(reason.name, "SessionBusyError", `D: loser rejected with ${reason.name}, not SessionBusyError`);

  // Exactly one run reached the model, so no view could fork.
  assert.equal(views.length, 1, `D: expected one run to reach the model, saw ${views.length}`);

  // And the loser wrote nothing: the log holds only the winner's turn.
  const reopened = await repository.open(id);
  const page = await reopened!.store.readRecordPage({ limit: 200 });
  await reopened!.store.close?.();
  const users = page.data.filter((r) => (r.record as Rec).message?.role === "user").length;
  assert.equal(users, 1, `D: expected only the winner's turn durable, saw ${users}`);
  console.log("D OK — with a lock, the loser gets SessionBusyError and writes nothing");
}

interface Rec {
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

function userText(m: { readonly content?: unknown }): string {
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.find((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text");
    if (text) return text.text;
  }
  return "user";
}

await toolsAcrossRequests();
await interruptAcrossRequests();
await concurrentRequestsForkWithoutALock();
await aLockSerializesTheSameRace();

faux.unregister();
rmSync(root, { recursive: true, force: true });
