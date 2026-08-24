/**
 * Goal-driven session + reading the conversation log back.
 *
 * Two things a plain prompt doesn't show:
 *
 *   1. GOALS — `session.createGoal({ objective, budget })` sets a standing objective with a
 *      turn/token budget. The agent keeps working toward it across turns until it's met or
 *      the budget runs out; `getGoal()` reports progress (turns/tokens used, remaining).
 *   2. THE LOG — the session is a flat, linear, append-only record stream. `getRecords()`
 *      returns it; current history is just a forward reduction of it. We print the record
 *      types and rebuild the transcript from `context.append_message` records.
 *
 * Run:  ANTHROPIC_API_KEY=... pnpm start
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
const WORK = join(process.cwd(), "workspace");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}
mkdirSync(WORK, { recursive: true });

const session = await createLocalSession({
  model: resolveModel(MODEL),
  homeDir: join(process.cwd(), ".agent-home"),
  workDir: WORK,
  permission: { mode: "workspace" },
  appendSystemPrompt: "You are working toward a standing goal. Be concise.",
});

// 1. Set a goal with a budget: at most 6 turns / 60k tokens.
const goal = await session.createGoal({
  objective: "Create a small Python project scaffold: main.py with a greet() function, plus a README.md that documents it.",
  budget: { turns: 6, tokens: 60_000 },
});
console.log(`🎯 goal: ${goal.objective}`);
console.log(`   budget: ${goal.budget.remainingTurns ?? "∞"} turns · ${goal.budget.remainingTokens ?? "∞"} tokens\n`);

// 2. Drive it. A goal-driven session keeps going toward the objective; here one prompt
//    kicks it off and the goal keeps the agent on task. `onEvent` is the callback way to
//    watch the stream — subscribe once, then prompt.
session.onEvent(render);
await session.prompt("Start working on the goal.");

// Goal progress after the run.
const after = await session.getGoal();
if (after) {
  console.log(`\n🎯 ${after.status} · ${after.turnsUsed} turns · ${after.tokensUsed} tokens used` +
    (after.terminalReason ? ` · ${after.terminalReason}` : ""));
}

// 3. Read the flat conversation log back.
const records = await session.getRecords();
console.log(`\n📒 log: ${records.length} records`);
const counts = new Map<string, number>();
for (const r of records) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
for (const [type, n] of counts) console.log(`   ${type.padEnd(26)} ×${n}`);

console.log(`\n📜 transcript (reduced from the log):`);
for (const r of records) {
  if (r.type !== "context.append_message") continue;
  const msg = r.message;
  const text = typeof msg.content === "string"
    ? msg.content
    : msg.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("").trim();
  if (text) console.log(`   [${msg.role}] ${clip(text)}`);
}

await session.close();

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "tool.call.started":
      process.stdout.write(`  ⚙︎ ${ev.toolName} ${preview(ev.args)}\n`);
      break;
    case "tool.result":
      process.stdout.write(`  ↳ ${ev.toolName}: ${ev.isError ? "error" : "ok"}\n`);
      break;
    case "error":
      process.stdout.write(`  ✖ ${ev.message}\n`);
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
function clip(s: string): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > 100 ? `${one.slice(0, 97)}…` : one;
}
