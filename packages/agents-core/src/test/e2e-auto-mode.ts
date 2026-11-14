import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type ToolCall } from "./faux.ts";
import { AUTO_MODE_DENIAL_LIMITS, bashTool, ConversationContext, defineModel, LocalEnvironment, PermissionManager, permissionDenialOf, writeTool } from "../index.ts";
import { runTurn } from "../internal.ts";
import type { AutoApprover, AutoApprovalVerdict, Logger, PermissionRule, ResolvedToolExecutionHookContext, Responder, ToolResultMessage } from "../index.ts";

// A stub judge that records how many times it was consulted, so each scenario can assert
// whether the static chain short-circuited (judge skipped) or actually reached the judge.
function judge(decision: "allow" | "escalate" | "block"): { approver: AutoApprover; calls: () => number } {
  let n = 0;
  const verdict: AutoApprovalVerdict =
    decision === "block" ? { decision, reason: "[Irreversible Local Destruction] deletes files", category: "Irreversible Local Destruction" } : { decision };
  return { approver: { classify: async () => ((n += 1), verdict) }, calls: () => n };
}

/** A responder that counts the approval prompts it gets and answers them all the same way. */
function countingResponder(decision: "approved" | "rejected"): { responder: Responder; prompts: () => number } {
  let n = 0;
  return { responder: { requestApproval: async () => ((n += 1), { decision }) }, prompts: () => n };
}

/** An authorize context for `pm.authorize` directly — for scenarios that drive many calls. */
function authCtx(toolName: string, args: unknown): ResolvedToolExecutionHookContext {
  return {
    turnId: "t",
    stepNumber: 1,
    signal: new AbortController().signal,
    model: undefined as never,
    toolCall: fauxToolCall(toolName, args as Record<string, unknown>),
    tool: undefined,
    args,
    plan: { approvalRule: toolName, run: async () => ({ content: [] }) },
  };
}

const reject = (feedback: string): Responder => ({ requestApproval: async () => ({ decision: "rejected", feedback }) });

async function runScenario(
  opts: { rules?: PermissionRule[]; mode?: "manual" | "workspace" | "yolo" | "auto"; responder?: Responder; gitInit?: boolean; autoApprover?: AutoApprover; logger?: Logger },
  call: ToolCall,
  tools = [bashTool, writeTool],
): Promise<{ text: string; isError: boolean; details?: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-auto-"));
  const { gitInit, autoApprover, ...pmOpts } = opts;
  if (gitInit) mkdirSync(join(dir, ".git")); // a bare `.git` dir marks the work tree
  const context = new ConversationContext();
  context.seed([{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }]);
  // The judge gets the live transcript via getTranscript — the authorize ctx carries none.
  const pm = new PermissionManager({
    ...pmOpts,
    cwd: dir,
    environment: new LocalEnvironment(dir),
    ...(autoApprover ? { autoApprover, getTranscript: () => context.messages } : {}),
  });
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("done", { stopReason: "stop" })]);
  const messages = context.messages;
  await runTurn({
    turnId: "t",
    signal: new AbortController().signal,
    model: faux.getChatModel()!,
    environment: new LocalEnvironment(dir),
    context,
    tools,
    hooks: { authorizeToolExecution: pm.authorize },
    maxSteps: 5,
  });
  faux.unregister();
  rmSync(dir, { recursive: true, force: true });
  const tr = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
  return { text: tr?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "", isError: tr?.isError ?? true, details: tr?.details };
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
  // BLOCK → refused with the reason, straight back to the model: no human is asked.
  const jBlock = judge("block");
  const blockPrompts = countingResponder("approved");
  const blocked = await runScenario({ mode: "auto", autoApprover: jBlock.approver, responder: blockPrompts.responder }, bash(NEEDS_JUDGE));

  // DENIAL LIMIT: blocks go back to the model until the 3rd in a row, which asks a human
  // instead; both counts then start over. A call that goes ahead resets the consecutive count.
  const limitJudge = judge("block");
  const limitPrompts = countingResponder("rejected");
  const limitPm = new PermissionManager({ mode: "auto", autoApprover: limitJudge.approver, responder: limitPrompts.responder });
  const risky = () => limitPm.authorize(authCtx("Bash", { command: "rm -rf build" }));
  const r1 = await risky();
  const r2 = await risky();
  const promptsBefore3rd = limitPrompts.prompts();
  const r3 = await risky(); // 3rd consecutive → human (who rejects)
  const r4 = await risky(); // counts restarted → back to the model
  const afterRestart = limitPrompts.prompts();
  await risky(); // 2nd consecutive since the restart
  await limitPm.authorize(authCtx("Read", { path: "a" })); // goes ahead → consecutive count resets
  const r7 = await risky();
  const r8 = await risky();
  const promptsAfterReset = limitPrompts.prompts();
  const blockedReason = (r: Awaited<ReturnType<typeof risky>>) => r?.block === true && permissionDenialOf(r.blockDetails) === "automode-blocked";

  // TOTAL LIMIT: blocks broken up by calls that go ahead never hit the consecutive limit, but
  // the 20th block in all asks a human.
  const totalJudge = judge("block");
  const totalPrompts = countingResponder("approved");
  const totalPm = new PermissionManager({ mode: "auto", autoApprover: totalJudge.approver, responder: totalPrompts.responder });
  const promptsAt: number[] = [];
  for (let i = 1; i <= AUTO_MODE_DENIAL_LIMITS.maxTotal; i++) {
    await totalPm.authorize(authCtx("Bash", { command: `rm -rf build${i}` }));
    promptsAt.push(totalPrompts.prompts());
    await totalPm.authorize(authCtx("Read", { path: "a" }));
  }

  // DENIAL KINDS on the refused result: a deny rule, a person's "no".
  const ruleDenied = await runScenario({ mode: "manual", rules: [{ decision: "deny", scope: "user", pattern: "Bash" }] }, bash("echo hi"));
  const userRejected = await runScenario({ mode: "manual", responder: reject("no thanks") }, bash(NEEDS_JUDGE));

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
    [
      "judge block → refused with reason + guidance, recorded as automode-blocked, no human asked",
      blocked.isError && blocked.text.includes("denied by the auto mode safety classifier") && blocked.text.includes("[Irreversible Local Destruction] deletes files") &&
        blocked.text.includes("Do not try to work around") && permissionDenialOf(blocked.details) === "automode-blocked" &&
        (blocked.details as { category?: string }).category === "Irreversible Local Destruction" && blockPrompts.prompts() === 0 && jBlock.calls() === 1,
    ],
    [
      "3rd consecutive block asks a human, counts restart, a call that goes ahead resets the run",
      blockedReason(r1) && blockedReason(r2) && promptsBefore3rd === 0 && limitPrompts.prompts() >= 1 && r3?.block === true &&
        permissionDenialOf(r3.blockDetails) === "rejected-by-user" && blockedReason(r4) && afterRestart === 1 &&
        blockedReason(r7) && blockedReason(r8) && promptsAfterReset === 1,
    ],
    [
      "20th block in all asks a human even with no consecutive run",
      promptsAt.slice(0, AUTO_MODE_DENIAL_LIMITS.maxTotal - 1).every((n) => n === 0) && promptsAt.at(-1) === 1,
    ],
    [
      "refusals record their kind: deny rule → blocked-by-permissions, person → rejected-by-user",
      permissionDenialOf(ruleDenied.details) === "blocked-by-permissions" && permissionDenialOf(userRejected.details) === "rejected-by-user" && userRejected.text.includes("no thanks"),
    ],
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
