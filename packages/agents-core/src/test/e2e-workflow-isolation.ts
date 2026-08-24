import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  BackgroundManager,
  backgroundCapability,
  createWorktree,
  DiskSessionStore,
  defineAgent,
  defineModel,
  LocalMachine,
  type Message,
  Runner,
  Session,
  SessionProjection,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A — createWorktree (business logic over machine.exec + withCwd) on a real repo
// ─────────────────────────────────────────────────────────────────────────────
async function testWorktree(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "wf-repo-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");

    const machine = new LocalMachine(repo);

    // Dirty worktree → kept for inspection.
    const wt = await createWorktree(machine, { label: "alpha" });
    check("createWorktree returns a handle in a git repo", wt !== null);
    if (wt) {
      check("worktree cwd exists on disk", existsSync(wt.cwd));
      check("scoped machine getcwd() == worktree cwd", wt.machine.getcwd() === wt.cwd);
      await wt.machine.writeText("scratch.txt", "isolated");
      check("write via scoped machine lands IN the worktree", existsSync(join(wt.cwd, "scratch.txt")));
      check("write does NOT touch the main repo", !existsSync(join(repo, "scratch.txt")));
      await wt.cleanup();
      check("dirty worktree kept after cleanup (has uncommitted scratch.txt)", existsSync(wt.cwd));
    }

    // Clean worktree → removed on cleanup.
    const wt2 = await createWorktree(machine, { label: "beta" });
    check("second worktree created", wt2 !== null);
    if (wt2) {
      await wt2.cleanup();
      check("clean worktree removed on cleanup", !existsSync(wt2.cwd));
    }

    // Non-repo dir → null (graceful: caller degrades to shared workspace).
    const nonRepo = mkdtempSync(join(tmpdir(), "wf-norepo-"));
    try {
      const ns = new LocalMachine(nonRepo);
      check("createWorktree returns null outside a git repo", (await createWorktree(ns)) === null);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part B — Background execution: run_in_background returns a task_id, the workflow
// runs detached on the BackgroundManager, and BackgroundOutput yields the result.
// ─────────────────────────────────────────────────────────────────────────────
function taskIdFrom(messages: readonly Message[]): string | undefined {
  const blob = JSON.stringify(messages);
  return /task_id:\s*([a-zA-Z0-9_-]+)/.exec(blob)?.[1];
}

function toolResultText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

async function testBackground(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wf-bg-"));
  try {
    const store = new DiskSessionStore(join(root, "s"));
    const mgr = new BackgroundManager();
    const session = await Session.open({ store, background: mgr, capabilities: [backgroundCapability(mgr)] });
    const runner = new Runner({ background: mgr, capabilities: [backgroundCapability(mgr)] });
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const worker = defineAgent({ name: "worker", model, instructions: "Do." });
    const mainAgent = defineAgent({ name: "main", model, instructions: "Coord.", subagents: [worker] });

    // A zero-agent script so the background run consumes no faux responses — keeps
    // the response queue deterministic between parent and the detached workflow.
    const script = ["export const meta = { name: 'bg-demo', description: 'bg' }", "log('working')", "return { answer: 99 }"].join("\n");

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Workflow", { script, run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("launched", { stopReason: "stop" }),
    ]);

    const r = await runner.run(mainAgent, "run in background", { session });
    faux.unregister();
    check("parent run completes immediately", r.status === "completed", r.status);

    const taskId = taskIdFrom(r.messages);
    check("Workflow returned a task_id (background mode)", taskId !== undefined, JSON.stringify(r.messages).slice(0, 160));

    if (taskId !== undefined) {
      // Poll until the detached workflow settles.
      let status = mgr.getTask(taskId)?.status;
      for (let i = 0; i < 100 && status !== undefined && status !== "completed" && status !== "failed" && status !== "timed_out" && status !== "killed"; i++) {
        await sleep(20);
        status = mgr.getTask(taskId)?.status;
      }
      check("background workflow reached completed", status === "completed", String(status));

      // The task holds no output: this is its journal, read back and rendered. It is the same
      // record `resumeFromRunId` replays from and the same one a UI seeds its progress view
      // with — not a copy the task kept, which is why it survives the process that wrote it.
      const output = (await session.readBackgroundTaskOutput(taskId)).content;
      check("task output is the run's journal, not a copy it kept", output.includes("workflow: bg-demo"), output.slice(0, 200));
      check("journal carries the run's outcome", output.includes("outcome: completed"), output.slice(0, 200));
      check("background workflow result is correct", output.includes('{"answer":99}'), output.slice(0, 200));
      check("the script's own log() narration is recorded", output.includes("working"), output.slice(0, 200));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testFailedWorkflowClosesItsJournal(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wf-failed-"));
  try {
    const store = new DiskSessionStore(join(root, "s"));
    const mgr = new BackgroundManager();
    const session = await Session.open({ store, background: mgr, capabilities: [backgroundCapability(mgr)] });
    const runner = new Runner({ background: mgr, capabilities: [backgroundCapability(mgr)] });
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const worker = defineAgent({ name: "worker", model, instructions: "Do." });
    const mainAgent = defineAgent({ name: "main", model, instructions: "Coord.", subagents: [worker] });
    const script = ["export const meta = { name: 'failed-demo', description: 'fails' }", "throw new Error('boom')"].join("\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Workflow", { script, run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("launched", { stopReason: "stop" }),
    ]);
    const result = await runner.run(mainAgent, "run failed workflow", { session });
    faux.unregister();
    const taskId = taskIdFrom(result.messages);
    check("failed workflow still returns a task id", taskId !== undefined);
    if (taskId !== undefined) {
      const info = await mgr.wait(taskId, 3000);
      check("failed workflow maps to task failed", info?.status === "failed", String(info?.status));
      const output = (await session.readBackgroundTaskOutput(taskId)).content;
      check("failed workflow journal has a terminal outcome", output.includes("outcome: failed") && output.includes("boom"), output);
      const projection = await SessionProjection.attach({ id: session.id, store, events: session.events });
      check("failed workflow projection is no longer live", projection.snapshot().workflows.find((run) => run.runId === info?.runId)?.live === false);
      projection.detach();
    }
    await session.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testStorelessWorkflowIsRejected(): Promise<void> {
  const mgr = new BackgroundManager();
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const worker = defineAgent({ name: "worker", model, instructions: "Do." });
  const mainAgent = defineAgent({ name: "main", model, instructions: "Coord.", subagents: [worker] });
  const script = ["export const meta = { name: 'storeless', description: 'x' }", "return 1"].join("\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Workflow", { script, run_in_background: true }), { stopReason: "toolUse" }),
    fauxAssistantMessage("handled", { stopReason: "stop" }),
  ]);
  const result = await new Runner({ background: mgr, capabilities: [backgroundCapability(mgr)] }).run(mainAgent, "go");
  faux.unregister();
  check(
    "storeless workflow is rejected before a task id is issued",
    toolResultText(result.messages).includes("requires a durable session store") && mgr.list(false).length === 0,
  );
}

async function main(): Promise<void> {
  await testWorktree();
  await testBackground();
  await testFailedWorkflowClosesItsJournal();
  await testStorelessWorkflowIsRejected();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : "FAILURES"}: ${checks.length - failed.length}/${checks.length}`);
  if (failed.length > 0) process.exit(1);
}

await main();
