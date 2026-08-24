/**
 * Steer, interrupt, and human-in-the-loop approvals.
 *
 * Three control-plane features you can't see from a plain prompt/response:
 *
 *   1. APPROVALS — with `permission: { mode: "manual" }` every tool call pauses for a
 *      human decision. `setApprovalHandler` is where you'd surface a prompt in your UI;
 *      here it auto-approves file tools and rejects `bash`, logging each decision.
 *   2. STEER — `session.steer(text)` injects a message into the turn that is ALREADY
 *      running. We fire one the moment the agent starts using a tool.
 *   3. CANCEL — `session.cancel()` aborts the in-flight run. Pass `--cancel` to see a
 *      run stopped after 3s (status → "aborted").
 *
 * Run:  ANTHROPIC_API_KEY=... pnpm start
 *       ANTHROPIC_API_KEY=... pnpm start --cancel
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalSession,
  defineModel,
  type AgentEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  type ChatModel,
} from "operon-agents";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const WORK = join(process.cwd(), "workspace");
const CANCEL = process.argv.includes("--cancel");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}
mkdirSync(WORK, { recursive: true });

const session = await createLocalSession({
  model: resolveModel(MODEL),
  homeDir: join(process.cwd(), ".agent-home"),
  workDir: WORK,
  permission: { mode: "manual" }, // every tool call routes to the approval handler
  appendSystemPrompt: "Prefer the file tools over shell when possible.",
});

// 1. Human-in-the-loop: decide each tool call. In a real UI this awaits a click.
session.setApprovalHandler((req: ApprovalRequest): ApprovalResponse => {
  const allow = req.toolName !== "bash"; // policy: files yes, shell no
  console.log(`  🔐 approval: ${req.toolName} → ${allow ? "APPROVED" : "REJECTED"}`);
  return allow
    ? { decision: "approved" }
    : { decision: "rejected", feedback: "Shell is disabled in this demo — use the file tools." };
});

if (CANCEL) {
  await cancelDemo();
} else {
  await steerDemo();
}
await session.close();

/** Stream a task and steer it as soon as the first tool call lands. */
async function steerDemo(): Promise<void> {
  const task = "create a file plan.md with a 3-step plan for adding a CLI to this project";
  console.log(`❯ ${task}\n`);
  const handle = session.promptStream(task);
  let steered = false;
  for await (const ev of handle) {
    render(ev);
    if (ev.type === "tool.call.started" && !steered) {
      steered = true;
      session.steer("Actually, make it a 5-step plan and add a 'Testing' step.");
      console.log(`  ↯ steered mid-run\n`);
    }
  }
  const result = await handle.completed;
  console.log(`\n─ ${result.status} ─`);
}

/** Kick a task and abort it after 3s to show a cancelled run. */
async function cancelDemo(): Promise<void> {
  const task = "write a very long, detailed 2000-word essay about distributed systems into essay.md";
  console.log(`❯ ${task}\n(cancelling in 3s…)\n`);
  const handle = session.promptStream(task);
  const timer = setTimeout(() => {
    console.log(`\n  ✖ cancel() — aborting the run`);
    session.cancel();
  }, 3000);
  for await (const ev of handle) render(ev);
  clearTimeout(timer);
  const result = await handle.completed;
  console.log(`\n─ ${result.status} ─  (expected: aborted)`);
}

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "assistant.delta":
      process.stdout.write(ev.delta);
      break;
    case "tool.call.started":
      process.stdout.write(`\n  ⚙︎ ${ev.toolName} ${preview(ev.args)}\n`);
      break;
    case "tool.result":
      process.stdout.write(`  ↳ ${ev.toolName}: ${ev.isError ? "error" : "ok"}\n`);
      break;
    case "error":
      process.stdout.write(`\n  ✖ ${ev.message}\n`);
      break;
  }
}

function resolveModel(id: string): ChatModel {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`MODEL must be "provider/model", got "${id}"`);
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
}

function preview(args: unknown): string {
  const s = JSON.stringify(args);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
