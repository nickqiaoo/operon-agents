import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type ToolCall } from "./faux.ts";
import { bashTool, ConversationContext, defineModel, LocalMachine, PermissionManager, writeTool } from "../index.ts";
import { runTurn } from "../internal.ts";
import type { AutoApprover, Logger, PermissionRule, Responder, ToolResultMessage } from "../index.ts";

// A stub judge that records how many times it was consulted, so each scenario can assert
// whether the static chain short-circuited (judge skipped) or actually reached the judge.
function judge(decision: "allow" | "escalate"): { approver: AutoApprover; calls: () => number } {
  let n = 0;
  return { approver: { classify: async () => ((n += 1), { decision }) }, calls: () => n };
}

const reject = (feedback: string): Responder => ({ requestApproval: async () => ({ decision: "rejected", feedback }) });

async function runScenario(
  opts: { rules?: PermissionRule[]; mode?: "manual" | "workspace" | "yolo" | "auto"; responder?: Responder; gitInit?: boolean; autoApprover?: AutoApprover; logger?: Logger },
  call: ToolCall,
  tools = [bashTool, writeTool],
): Promise<{ text: string; isError: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-auto-"));
  const { gitInit, autoApprover, ...pmOpts } = opts;
  if (gitInit) mkdirSync(join(dir, ".git")); // a bare `.git` dir marks the work tree
  const context = new ConversationContext();
  context.seed([{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }]);
  // The judge gets the live transcript via getTranscript — the authorize ctx carries none.
  const pm = new PermissionManager({
    ...pmOpts,
    cwd: dir,
    machine: new LocalMachine(dir),
    ...(autoApprover ? { autoApprover, getTranscript: () => context.messages } : {}),
  });
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("done", { stopReason: "stop" })]);
  const messages = context.messages;
  await runTurn({
    turnId: "t",
    signal: new AbortController().signal,
    model: faux.getChatModel()!,
    machine: new LocalMachine(dir),
    context,
    tools,
    hooks: { authorizeToolExecution: pm.authorize },
    maxSteps: 5,
  });
  faux.unregister();
  rmSync(dir, { recursive: true, force: true });
  const tr = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
  return { text: tr?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "", isError: tr?.isError ?? true };
}

const bash = (cmd: string): ToolCall => fauxToolCall("Bash", { command: cmd });
/** Writes, so it reaches the judge instead of being cleared by bash-read-only-approve, and
 *  still prints BASH_OK so the "did it actually run" assertions keep working. */
const NEEDS_JUDGE = "touch .auto-mode-probe && echo BASH_OK";
const write = (path: string): ToolCall => fauxToolCall("Write", { path, content: "x" });

async function main(): Promise<void> {
  // DENY rules still win above the judge — and the judge is never consulted.
  const jDeny = judge("allow");
  const denied = await runScenario(
    { mode: "auto", rules: [{ decision: "deny", scope: "user", pattern: "Bash" }], autoApprover: jDeny.approver },
    bash("echo BASH_OK"),
  );

  // FREE FAST-PATH: a recoverable in-cwd write is approved by git-cwd-write-approve before the
  // ask, so the judge is skipped even though it would have escalated.
  const jFast = judge("escalate");
  const fastPath = await runScenario({ mode: "auto", gitInit: true, autoApprover: jFast.approver }, write("note.md"));

  // GENERIC ASK (bash → fallback-ask): judge ALLOW → runs without a prompt.
  // The command must NOT be one the read-only fast path recognizes, or it is approved before
  // the judge is ever consulted — `touch` is what keeps this scenario about the judge.
  const jAllowBash = judge("allow");
  const allowed = await runScenario({ mode: "auto", autoApprover: jAllowBash.approver }, bash(NEEDS_JUDGE));

  // GENERIC ASK: judge ESCALATE → falls through to the human, who rejects.
  const jEsc = judge("escalate");
  const escalated = await runScenario(
    { mode: "auto", autoApprover: jEsc.approver, responder: reject("human-said-no") },
    bash(NEEDS_JUDGE),
  );

  // HUMAN-ONLY: an explicit user `ask` rule is classifierApprovable=false, so the judge is
  // skipped and it goes straight to the human (who rejects).
  const jHumanOnly = judge("allow");
  const humanOnly = await runScenario(
    { mode: "auto", rules: [{ decision: "ask", scope: "user", pattern: "Bash" }], autoApprover: jHumanOnly.approver, responder: reject("human-only") },
    bash("echo BASH_OK"),
  );

  // SAFETY FLOOR reaches the judge: writing into `.git/` is a
  // git-control ASK, which in auto mode is handed to the judge — ALLOW → runs.
  const jFloor = judge("allow");
  const floor = await runScenario({ mode: "auto", gitInit: true, autoApprover: jFloor.approver }, write(".git/x"));

  // DIAGNOSTIC TRAIL: every judge consult is logged (verdict + toolName + duration), and a
  // THROWN judge leaves a warn entry with the error — otherwise a dead judge is
  // indistinguishable from "auto mode just always asks".
  const logged: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const captureLogger: Logger = { log: (level, message, fields) => void logged.push({ level, message, fields }) };
  const jLogged = judge("allow");
  await runScenario({ mode: "auto", autoApprover: jLogged.approver, logger: captureLogger }, bash(NEEDS_JUDGE));
  const boomJudge: AutoApprover = { classify: async () => { throw new Error("boom"); } };
  const thrown = await runScenario(
    { mode: "auto", autoApprover: boomJudge, responder: reject("human-after-boom"), logger: captureLogger },
    bash(NEEDS_JUDGE),
  );
  const allowEntry = logged.find((e) => e.message === "auto-approval judge: allow");
  const errorEntry = logged.find((e) => e.message.includes("judge threw"));

  const checks: Array<[string, boolean]> = [
    ["deny rule wins, judge not consulted", denied.isError && denied.text.toLowerCase().includes("denied") && jDeny.calls() === 0],
    ["static approve (git-cwd write) bypasses judge", !fastPath.isError && fastPath.text.includes("bytes") && jFast.calls() === 0],
    ["judge allow → bash runs (no prompt)", !allowed.isError && allowed.text.includes("BASH_OK") && jAllowBash.calls() === 1],
    ["judge escalate → human rejects", escalated.isError && escalated.text.includes("human-said-no") && jEsc.calls() === 1],
    ["user ask rule is human-only, judge skipped", humanOnly.isError && humanOnly.text.includes("human-only") && jHumanOnly.calls() === 0],
    ["safety-floor (.git) ask reaches judge → allow runs", !floor.isError && floor.text.includes("bytes") && jFloor.calls() === 1],
    ["judge verdict logged with toolName + duration", allowEntry !== undefined && allowEntry.level === "debug" && allowEntry.fields?.["toolName"] === "Bash" && typeof allowEntry.fields?.["durationMs"] === "number"],
    ["thrown judge logs a warn with the error and still escalates to the human", errorEntry !== undefined && errorEntry.level === "warn" && errorEntry.fields?.["error"] === "boom" && thrown.isError && thrown.text.includes("human-after-boom")],
  ];
  const ok = checks.every(([, pass]) => pass);
  for (const [label, pass] of checks) console.log(pass ? "✅" : "❌", label);
  console.log(ok ? "\n✅ AUTO-MODE E2E PASS — chain short-circuit + judge intercept (incl. safety floor) + human escalation" : "\n❌ AUTO-MODE E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ ERROR:", error);
  process.exit(1);
});
