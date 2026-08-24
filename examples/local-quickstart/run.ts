/**
 * Local quickstart — the smallest thing that works.
 *
 * One local session, one prompt, events streamed to the console, final result
 * printed. Tools run on THIS machine, scoped to ./workspace. This is the local
 * composition root (`createLocalSession`): disk-persisted sessions, local
 * machine, cron on — all wired by the preset, nothing to assemble.
 *
 * Run:  ANTHROPIC_API_KEY=... pnpm start
 *       ANTHROPIC_API_KEY=... pnpm start "count the lines in package.json"
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalSession,
  defineModel,
  type AgentEvent,
  type ChatModel,
} from "operon-agents";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const HOME = join(process.cwd(), ".agent-home"); // sessions persist here (resumable)
const WORK = join(process.cwd(), "workspace"); // the agent's sandbox on disk
const TASK = process.argv[2] ?? "create a file greeting.txt containing a haiku, then read it back to me";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}
mkdirSync(WORK, { recursive: true });

// A local session, ready to prompt. `permission: workspace` auto-approves tool use
// as long as it stays inside the workspace — safe for running on your own machine.
const session = await createLocalSession({
  model: resolveModel(MODEL),
  homeDir: HOME,
  workDir: WORK,
  permission: { mode: "workspace" },
  appendSystemPrompt: "Be concise. Use the tools; explain briefly what you do.",
});

console.log(`session ${session.id}  ·  model ${MODEL}  ·  workspace ${WORK}\n`);
console.log(`❯ ${TASK}\n`);

// Two ways to consume events: (1) the callback below — subscribe once, then just prompt;
// (2) the streaming handle `session.promptStream(task)` is async-iterable (see the server
// examples). The callback is the simplest.
session.onEvent(render);
const result = await session.prompt(TASK);

console.log(`\n─ ${result.status} · ${result.usage.output} output tokens ─`);
await session.close();

/** Compact console renderer for the event stream. */
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
